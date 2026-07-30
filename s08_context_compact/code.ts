#!/usr/bin/env tsx
/**
 * s08_context_compact/code.ts — Auto-Compaction (Codex-style, in TypeScript)
 *
 * The agent loop from s01 never forgets: every user message, every tool call
 * and every tool output piles into the thread. But the context window is
 * finite — a long session eventually overflows and the API refuses the request
 * (Codex hits this as a prompt/token-limit error).
 *
 * Auto-compaction keeps the session alive:
 *
 *     before each model call:
 *         estimate tokens(thread)
 *         if over budget:
 *             summarize the OLD turns into ONE compact item
 *             drop the originals, keep the current turn verbatim
 *         run the normal agent loop
 *
 *     thread: [u1][a1][u2][a2][u3][a3][u4]...     (grows forever)
 *                 \__summarized__/   \_kept_/
 *     after:  [compact-summary][u4][a4...]        (small again, loop continues)
 *
 * This is Codex's auto-compaction in miniature: an approximate token budget,
 * and when it is exceeded the older history collapses into a single summary
 * item while the conversation keeps going.
 *
 * Run it:
 *     npm install
 *     npx tsx s08_context_compact/code.ts                       # offline demo (no key)
 *     OPENAI_API_KEY=sk-... npx tsx s08_context_compact/code.ts # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

const INSTRUCTIONS =
  `You are a coding agent running in ${CWD}. ` +
  `Use the shell tool to solve the task. Act, don't explain.`;

// ── NEW in s08: an approximate token budget for the thread ──────────────────
// We estimate tokens as chars/4 — a common heuristic (Codex counts real
// tokens). When the estimate crosses TOKEN_BUDGET, the older turns collapse
// into one compact summary item. Kept deliberately tiny so the demo compacts
// after only a few turns.
const TOKEN_BUDGET = 700;
const CHARS_PER_TOKEN = 4;

type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

// Rough token estimate for the whole thread: serialize each item and count
// characters. Good enough to decide "are we over budget yet?".
function approxTokens(thread: unknown[]): number {
  let chars = 0;
  for (const item of thread) chars += JSON.stringify(item).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ── The one tool: a shell (same as s01) ─────────────────────────────────────
const TOOLS = [
  {
    type: "function" as const,
    name: "shell",
    description: "Run a shell command and return its combined stdout+stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function runShell(command: string): string {
  try {
    const out = execSync(command, { cwd: CWD, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return (String(out).trim() || "(no output)").slice(0, 50_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

// ── Model adapter ───────────────────────────────────────────────────────────
const openai = OFFLINE ? null : new OpenAI();

async function callModel(input: unknown[]): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions: INSTRUCTIONS,
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "medium" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input);
}

// Offline stand-in: each turn runs one shell command with chunky output, then
// wraps up. If a compact summary is visible in the thread, it acknowledges it —
// proof the summary (not the dropped originals) is what the model now sees.
let callSeq = 0;
function offlineModel(input: unknown[]): OutputItem[] {
  const last = input[input.length - 1] as { type?: string } | undefined;
  if (last?.type === "function_call_output") {
    const sawSummary = input.some((i) =>
      JSON.stringify(i).includes("compacted into this summary")
    );
    const text = sawSummary
      ? "[offline demo] Earlier turns were compacted into a summary I can still see, and I kept working from it."
      : "[offline demo] Phase complete — ran the verbose step log.";
    return [{ type: "message", content: [{ type: "output_text", text }] }];
  }
  const command =
    `node -e "console.log(Array.from({length:70},(_,i)=>'step '+String(i).padStart(2,'0')+' done').join('\\n'))"`;
  const id = `call_${++callSeq}`;
  return [{ type: "function_call", id, call_id: id, name: "shell", arguments: JSON.stringify({ command }) }];
}

// ── NEW in s08: summarize old turns, drop the originals ────────────────────
// Ask the model to compress the old turns into a short brief. Offline we return
// a scripted brief so the demo is deterministic.
async function summarize(oldTurns: unknown[]): Promise<string> {
  const transcript = oldTurns.map((i) => JSON.stringify(i)).join("\n");
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions:
        "Summarize this coding-agent transcript in at most 5 bullets. Keep the " +
        "current goal, files touched and pending work. Respond with text only.",
      input: transcript,
    });
    const item = (resp.output as unknown as OutputItem[]).find((i) => i.type === "message");
    return item?.content?.find((c) => c.type === "output_text")?.text ?? "(empty summary)";
  }
  const calls = oldTurns.filter((i) => (i as { type?: string }).type === "function_call").length;
  return (
    `[offline summary] The agent ran ${calls} shell command(s) over the earlier turns; ` +
    `each printed a verbose step log. The current goal and the most recent turn are kept verbatim.`
  );
}

// Collapse everything before the latest user message into one compact item.
// Splitting at the last user message is a safe boundary: it never separates a
// function_call from its function_call_output.
async function compactThread(thread: unknown[]): Promise<void> {
  let split = 0;
  for (let i = thread.length - 1; i >= 0; i--) {
    if ((thread[i] as { role?: string }).role === "user") { split = i; break; }
  }
  if (split === 0) return; // nothing old enough to compact yet
  const oldTurns = thread.slice(0, split);
  const summary = await summarize(oldTurns);
  const compactItem = {
    role: "user",
    content: `[Earlier conversation compacted into this summary]\n${summary}`,
  };
  const before = approxTokens(thread);
  thread.splice(0, thread.length, compactItem, ...thread.slice(split));
  console.log(
    `\x1b[35m[auto-compact] ${before} -> ${approxTokens(thread)} tokens ` +
    `(${oldTurns.length} items collapsed into 1 summary item)\x1b[0m`
  );
}

// ── The core loop (unchanged from s01) ──────────────────────────────────────
async function agentLoop(input: unknown[]): Promise<void> {
  for (;;) {
    const output = await callModel(input);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        if (item.type === "message")
          for (const c of item.content ?? [])
            if (c.type === "output_text" && c.text) console.log(c.text);
      return;
    }
    for (const call of calls) {
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      console.log(`\x1b[33m$ ${command.slice(0, 60)}...\x1b[0m`);
      const result = runShell(command);
      console.log(`\x1b[90m  ... (${result.length} chars of tool output into the thread)\x1b[0m`);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a scripted session that forces compaction ─────────────────
async function main(): Promise<void> {
  console.log("s08: Auto-Compaction (Codex-style)");
  console.log(
    OFFLINE
      ? `Offline demo model. Token budget ${TOKEN_BUDGET} — watch the thread grow, then compact.\n`
      : `Model: ${MODEL}. Token budget ${TOKEN_BUDGET} — watch the thread grow, then compact.\n`
  );

  const script = [
    "Run the step log for phase one.",
    "Run the step log for phase two.",
    "Run the step log for phase three.",
    "Run the step log for phase four.",
    "Now tell me: what have we been doing?",
  ];

  const thread: unknown[] = [];
  for (const query of script) {
    console.log(`\x1b[36ms08 >> \x1b[0m${query}`);
    thread.push({ role: "user", content: query });
    // NEW: compact BEFORE calling the model when the thread is over budget.
    // We do it at this turn boundary so a call is never split from its output.
    if (approxTokens(thread) > TOKEN_BUDGET) await compactThread(thread);
    console.log(`\x1b[90m[context ~${approxTokens(thread)} tokens / budget ${TOKEN_BUDGET}]\x1b[0m`);
    await agentLoop(thread);
    console.log();
  }
}

main();
