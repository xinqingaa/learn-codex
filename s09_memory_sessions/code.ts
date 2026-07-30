#!/usr/bin/env tsx
/**
 * s09_memory_sessions/code.ts — Rollout Persistence & Resume (Codex-style, in TypeScript)
 *
 * s01's thread lives only in memory: kill the process and the whole session is
 * gone. Codex instead records every session to disk as it happens, so you can
 * close it and come back — `codex resume` rebuilds the exact thread.
 *
 * The trick is an append-only, write-through log:
 *
 *     each time the thread grows (user msg, tool call, tool output, answer):
 *         append the new items as JSON lines to rollout.jsonl
 *
 *     on start, with --resume:
 *         read the file back, replay every line into a fresh thread
 *         continue exactly where the last session stopped
 *
 *     in-memory thread:      [u1][a1][u2][a2]...        (dies with the process)
 *     rollout.jsonl on disk: {u1}\n{a1}\n{u2}\n{a2}...  (survives)
 *     codex resume:          read lines -> rebuild thread -> keep going
 *
 * Run it:
 *     npm install
 *     npx tsx s09_memory_sessions/code.ts                       # offline demo (no key)
 *     npx tsx s09_memory_sessions/code.ts --resume              # resume the saved rollout
 *     OPENAI_API_KEY=sk-... npx tsx s09_memory_sessions/code.ts # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

const INSTRUCTIONS =
  `You are a coding agent running in ${CWD}. ` +
  `Use the shell tool to solve the task. Act, don't explain.`;

// ── NEW in s09: a rollout file the session is written through to ───────────
// Real Codex appends every turn to ~/.codex/sessions/<date>/rollout-<id>.jsonl.
// We default to the OS temp dir so the demo never dirties your repo; set
// CODEX_ROLLOUT to ./.codex/rollout.jsonl if you want a project-local file.
const ROLLOUT_PATH =
  process.env.CODEX_ROLLOUT ?? join(tmpdir(), "learn-codex-s09", "rollout.jsonl");
const RESUME = process.argv.includes("--resume") || process.env.CODEX_RESUME === "1";

// One record per line. A session_meta line opens the log; every later line is a
// single thread item (user message / function_call / function_call_output / message).
function startRollout(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const meta = {
    type: "session_meta",
    id: `sess_${Date.now()}`,
    cwd: CWD,
    started: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(meta) + "\n"); // truncate: a brand-new session
}

// Write-through: persist items the moment they are produced, one JSON per line.
function appendRollout(path: string, items: unknown[]): void {
  if (items.length === 0) return;
  appendFileSync(path, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
}

// `codex resume`: read the log back and replay every item into a fresh thread.
function loadRollout(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { type?: string })
    .filter((r) => r.type !== "session_meta");
}

// ── The one tool: a shell (unchanged from s01) ──────────────────────────────
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

// ── Model adapter (same Responses-API shape as s01) ─────────────────────────
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

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

// Offline stand-in: one shell call, then an answer that reports how much state
// is on disk — proof the log (not the process) is what carries the session.
let callSeq = 0;
function offlineModel(input: unknown[]): OutputItem[] {
  const last = input[input.length - 1] as { type?: string } | undefined;
  if (last?.type === "function_call_output") {
    return [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text:
              `[offline demo] Turn done. The thread now holds ${input.length} item(s); ` +
              `each is a JSON line in the rollout file, so a later \`codex resume\` rebuilds ` +
              `this exact state.`,
          },
        ],
      },
    ];
  }
  const id = `call_${++callSeq}`;
  return [
    {
      type: "function_call",
      id,
      call_id: id,
      name: "shell",
      arguments: JSON.stringify({ command: `echo "turn ${callSeq}: logged to rollout"` }),
    },
  ];
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
      console.log(`\x1b[33m$ ${command}\x1b[0m`);
      const result = runShell(command);
      console.log(result);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// Run one user turn and persist everything it adds to the thread.
async function runTurn(thread: unknown[], rolloutPath: string, query: string): Promise<void> {
  console.log(`\x1b[36ms09 >> \x1b[0m${query}`);
  const userItem = { role: "user", content: query };
  thread.push(userItem);
  appendRollout(rolloutPath, [userItem]); // persist the user turn first
  const before = thread.length;
  await agentLoop(thread);
  appendRollout(rolloutPath, thread.slice(before)); // then everything the turn added
  console.log();
}

// ── Entry point: write a session, then simulate `codex resume` ─────────────
async function main(): Promise<void> {
  console.log("s09: Rollout Persistence & Resume (Codex-style)");
  console.log(OFFLINE ? "Offline demo model (no key).\n" : `Model: ${MODEL}.\n`);

  let thread: unknown[];
  if (RESUME && existsSync(ROLLOUT_PATH)) {
    thread = loadRollout(ROLLOUT_PATH);
    console.log(`\x1b[35m[resume] loaded ${thread.length} item(s) from ${ROLLOUT_PATH}\x1b[0m\n`);
  } else {
    startRollout(ROLLOUT_PATH);
    thread = [];
    console.log(`\x1b[90m[new session] writing rollout -> ${ROLLOUT_PATH}\x1b[0m\n`);
  }

  for (const q of ["Show the working directory.", "Print a hello line."]) {
    await runTurn(thread, ROLLOUT_PATH, q);
  }

  if (!RESUME) {
    // Simulate quitting and relaunching with `codex resume`, within this run.
    console.log(`\x1b[90m--- process exits; relaunch with --resume (codex resume) ---\x1b[0m\n`);
    const restored = loadRollout(ROLLOUT_PATH);
    console.log(`\x1b[35m[resume] rebuilt thread: ${restored.length} item(s) replayed from disk\x1b[0m\n`);
    await runTurn(restored, ROLLOUT_PATH, "What did we do before the restart?");
  }

  console.log(`\x1b[90mRollout saved at ${ROLLOUT_PATH} (${loadRollout(ROLLOUT_PATH).length} items).\x1b[0m`);
}

main();
