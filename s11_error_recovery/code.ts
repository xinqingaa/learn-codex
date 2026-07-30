#!/usr/bin/env tsx
/**
 * s11_error_recovery/code.ts — Classified Retry (Codex-style, in TypeScript)
 *
 * s01's loop calls the model raw: any API error crashes the turn. A production
 * agent instead classifies each failure and picks a recovery path:
 *
 *     callModel() throws
 *         |
 *         v
 *     classifyError(err)
 *         |
 *         +-- rate_limit (429/529) --> backoff + jitter, retry (up to N)
 *         +-- context_overflow    --> compact the thread, retry ONCE
 *         +-- abort (user Esc)    --> stop the turn immediately
 *         +-- unknown             --> retry a couple times, then give up
 *
 * The loop itself never changes — only the model call is wrapped:
 *
 *     +---------+   throw    +------------+   retry/compact    +--------+
 *     |  Loop   | ---------> | classifier | -----------------> | Model  |
 *     +---------+            +------------+                    +--------+
 *
 * Run it:
 *     npm install
 *     npx tsx s11_error_recovery/code.ts          # offline demo: the model FAILS 3x first
 *     OPENAI_API_KEY=sk-... npx tsx s11_error_recovery/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

const INSTRUCTIONS =
  `You are a coding agent in ${CWD}. Use the shell tool to solve the task. Act, don't explain.`;

// ── NEW in s11: classify the error, then choose a recovery path ───────────
type ErrKind = "rate_limit" | "context_overflow" | "abort" | "unknown";

function classifyError(err: unknown): ErrKind {
  const e = err as { status?: number; code?: string; name?: string; message?: string };
  const msg = (e?.message ?? "").toLowerCase();
  if (e?.name === "AbortError" || msg.includes("abort")) return "abort";
  if (e?.status === 429 || e?.status === 529 || msg.includes("rate limit") || msg.includes("overload"))
    return "rate_limit";
  if (e?.status === 413 || e?.code === "context_length_exceeded" || msg.includes("too long") || msg.includes("maximum context"))
    return "context_overflow";
  return "unknown";
}

// ── NEW in s11: recovery policy knobs ──────────────────────────────────────
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_UNKNOWN_RETRIES = 2;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with jitter, the standard transient-error recipe.
function backoffDelay(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 32_000);
  return base + Math.random() * base * 0.25;
}

// Reactive compaction: drop the oldest turns, keep the recent ones, retry.
// (s08 builds full auto-compaction; this is the minimal "free some context".)
function compactThread(input: unknown[], keepRecent = 3): void {
  if (input.length <= keepRecent) return;
  const dropped = input.length - keepRecent;
  const tail = input.slice(-keepRecent);
  input.length = 0;
  input.push(
    { role: "user", content: `[compacted] ${dropped} earlier turn(s) summarized to free context.` },
    ...tail
  );
  console.log(`\x1b[90m[recovery] compacted ${dropped} earlier turn(s)\x1b[0m`);
}

// ── The chapter's only tool: a shell (unchanged from s01) ──────────────────
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
  const dangerous = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: dangerous command blocked";
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

// ── NEW in s11: the recovery wrapper around callModel ──────────────────────
async function callModelWithRecovery(input: unknown[]): Promise<OutputItem[]> {
  let rateLimitRetries = 0;
  let unknownRetries = 0;
  let compacted = false;
  for (;;) {
    try {
      return await callModel(input);
    } catch (err) {
      switch (classifyError(err)) {
        case "abort":
          console.log("\x1b[31m[recovery] aborted — stop the turn now\x1b[0m");
          throw err;
        case "rate_limit":
          if (rateLimitRetries++ < MAX_RATE_LIMIT_RETRIES) {
            const delay = backoffDelay(rateLimitRetries);
            console.log(`\x1b[33m[recovery] rate-limit → retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} after ~${Math.round(delay)}ms (backoff + jitter)\x1b[0m`);
            await sleep(OFFLINE ? Math.min(delay, 400) : delay); // offline caps the wait to stay snappy
            continue;
          }
          break;
        case "context_overflow":
          if (!compacted) {
            compacted = true;
            console.log("\x1b[33m[recovery] context overflow → reactive compact, then retry\x1b[0m");
            compactThread(input);
            continue;
          }
          break;
        default:
          if (unknownRetries++ < MAX_UNKNOWN_RETRIES) {
            console.log(`\x1b[33m[recovery] unknown error → retry ${unknownRetries}/${MAX_UNKNOWN_RETRIES}\x1b[0m`);
            await sleep(OFFLINE ? 200 : backoffDelay(unknownRetries));
            continue;
          }
      }
      console.log(`\x1b[31m[recovery] ${classifyError(err)} is unrecoverable → giving up\x1b[0m`);
      throw err;
    }
  }
}

// ── Offline demo: a scripted model that FAILS three classified ways first ───
function apiError(status: number, message: string, code?: string): Error & { status: number; code?: string } {
  const e = new Error(message) as Error & { status: number; code?: string };
  e.status = status;
  if (code) e.code = code;
  return e;
}

const failScript: Array<() => never> = OFFLINE
  ? [
      () => { throw apiError(429, "429 Too Many Requests: rate limit reached"); },
      () => { throw apiError(529, "529 The model is overloaded, retry later"); },
      () => { throw apiError(413, "Your prompt exceeded the maximum context length", "context_length_exceeded"); },
    ]
  : [];

function offlineModel(input: unknown[]): OutputItem[] {
  if (failScript.length > 0) failScript.shift()!(); // each model attempt pops one failure

  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (ran === 0) {
    return [{
      type: "function_call", id: "call_1", call_id: "call_1", name: "shell",
      arguments: JSON.stringify({ command: "ls -la" }),
    }];
  }
  return [{
    type: "message",
    content: [{
      type: "output_text",
      text:
        `[offline demo] The model call failed 3 times before succeeding: 429 + 529 (retried ` +
        `with exponential backoff), then a context-overflow (reactive compact, then retry). Only ` +
        `after recovering did it run the shell tool and finish. Set OPENAI_API_KEY for a real ` +
        `model — the recovery wrapper stays exactly the same.`,
    }],
  }];
}

// ── The agent loop: identical to s01, only the model call is wrapped ────────
async function agentLoop(input: unknown[]): Promise<void> {
  for (;;) {
    const output = await callModelWithRecovery(input); // ← s11: wrapped, not raw
    input.push(...output);

    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output) {
        if (item.type === "message") {
          for (const c of item.content ?? []) {
            if (c.type === "output_text" && c.text) console.log(c.text);
          }
        }
      }
      return;
    }

    for (const call of calls) {
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      console.log(`\x1b[33m$ ${command}\x1b[0m`);
      const result = runShell(command);
      console.log(result.split("\n").slice(0, 6).join("\n"));
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL ─────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s11: Classified Error Recovery (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo (no key). The model call will FAIL 3 times first — watch the recovery. q to quit.\n"
      : `Model: ${MODEL}. Type a task, or q to quit.\n`
  );

  // An async-iterator REPL: robust whether stdin is interactive or a closed
  // pipe (the recovery backoff sleeps would otherwise let the pipe hit EOF and
  // close the interface between prompts).
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const thread: unknown[] = [];
  // Seed a little prior history so the reactive compact has something to drop.
  if (OFFLINE) {
    thread.push(
      { role: "user", content: "(earlier) sketch a plan" },
      { role: "assistant", content: "(earlier) drafted a 3-step plan" },
      { role: "user", content: "(earlier) refine step 2" },
      { role: "assistant", content: "(earlier) refined step 2" },
    );
  }

  process.stdout.write("\x1b[36ms11 >> \x1b[0m");
  for await (const line of rl) {
    const query = line.trim();
    if (!query || ["q", "exit"].includes(query.toLowerCase())) break;
    thread.push({ role: "user", content: query });
    try {
      await agentLoop(thread);
    } catch (err) {
      console.error("agent error:", err instanceof Error ? err.message : err);
    }
    console.log();
    process.stdout.write("\x1b[36ms11 >> \x1b[0m");
  }
  rl.close();
}

main();
