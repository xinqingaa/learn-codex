#!/usr/bin/env tsx
/**
 * s13_background_tasks/code.ts — Async Background Execution (Codex-style, TS)
 *
 * A slow command (`npm install`, a build, a test suite) blocks the agent: the
 * loop sits in `execSync` doing nothing while the meter runs. The fix is to
 * detach it: spawn the command in the background, hand the model an id, let it
 * keep reasoning, and harvest the result on a later turn:
 *
 *     run_background("npm run build") ──> spawn (non-blocking) ──> bg_1
 *            |                                    |
 *            v                                    v (keeps running)
 *     model does other fast work           ...time passes...
 *            |                                    |
 *            └────> check_background(bg_1) ──> done → output harvested
 *
 * The loop is s01's; the only change is two new tools. `run_background` returns
 * immediately with an id instead of blocking; `check_background` polls the
 * registry and returns "still running" or the captured output. This is also how
 * `codex exec` (non-interactive) and any headless run drives work: same loop,
 * no human in the middle.
 *
 * Run it:
 *     npm install
 *     npx tsx s13_background_tasks/code.ts          # offline demo: build in bg, harvest later
 *     OPENAI_API_KEY=sk-... npx tsx s13_background_tasks/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync, spawn } from "node:child_process";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

const INSTRUCTIONS =
  `You are a coding agent in ${CWD}. For a slow command (build, test, install, deploy), ` +
  `use run_background to detach it, keep doing useful work with shell, then poll with ` +
  `check_background and harvest the output when it reports finished. Use shell for fast commands.`;

// ── NEW in s13: a registry of background tasks, spawned non-blocking ────────
type BgTask = { id: string; command: string; status: "running" | "done"; output: string };
const bgTasks = new Map<string, BgTask>();
let bgSeq = 0;

// Spawn the command detached and return immediately — the loop never blocks.
function startBackground(command: string): string {
  const id = `bg_${++bgSeq}`;
  const task: BgTask = { id, command, status: "running", output: "" };
  bgTasks.set(id, task);
  const child = spawn(command, { cwd: CWD, shell: true }); // async: returns at once
  child.stdout?.on("data", (d) => (task.output += String(d)));
  child.stderr?.on("data", (d) => (task.output += String(d)));
  child.on("close", (code) => {
    task.status = "done";
    task.output = (task.output.trim() || "(no output)") + `\n(exit ${code})`;
  });
  console.log(`\x1b[36m[bg] started ${id}: ${command}\x1b[0m`);
  return `Started ${id} in the background. It keeps running while you work; poll it with check_background.`;
}

// Yield to the event loop so a spawned child's queued "data"/"close" callbacks
// run before we read its status. execSync foreground work blocks the loop, so a
// background process may have exited at the OS level before Node has drained its
// pipes and fired "close"; a short real delay lets the loop catch up.
const flushIo = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

// Poll the registry: "still running", or the harvested output once finished.
async function checkBackground(id: string): Promise<string> {
  await flushIo();
  const t = bgTasks.get(id);
  if (!t) return `Error: no such background task ${id}`;
  if (t.status === "running") return `${id} still running: ${t.command}`;
  console.log(`\x1b[36m[bg] harvested ${id}\x1b[0m`);
  return `${id} finished: ${t.command}\n--- output ---\n${t.output}`;
}

// ── Synchronous shell for fast commands (unchanged from earlier chapters) ───
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

// ── Tool registry: dispatch by name (from s02). Handlers may be async. ──────
const DISPATCH: Record<string, (args: Record<string, unknown>) => string | Promise<string>> = {
  shell: (a) => {
    console.log(`\x1b[33m$ ${String(a.command)}\x1b[0m`);
    return runShell(String(a.command));
  },
  run_background: (a) => startBackground(String(a.command)),
  check_background: (a) => checkBackground(String(a.id)),
};

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const TOOLS = [
  { type: "function" as const, name: "shell", strict: true,
    description: "Run a fast shell command synchronously and return its output.",
    parameters: obj({ command: str("The shell command to run.") }, ["command"]) },
  { type: "function" as const, name: "run_background", strict: true,
    description: "Detach a slow command into the background; returns a task id immediately.",
    parameters: obj({ command: str("The slow command to run in the background.") }, ["command"]) },
  { type: "function" as const, name: "check_background", strict: true,
    description: "Poll a background task by id; returns 'still running' or its output.",
    parameters: obj({ id: str("The background task id, e.g. bg_1.") }, ["id"]) },
];

// ── Model adapter (same Responses-API shape as s01) ─────────────────────────
type OutputItem = {
  type: string; id?: string; call_id?: string; name?: string; arguments?: string;
  content?: { type: string; text?: string }[];
};
const openai = OFFLINE ? null : new OpenAI();

async function callModel(input: unknown[]): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL, instructions: INSTRUCTIONS, input: input as never, tools: TOOLS,
      reasoning: { effort: "medium" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input);
}

// ── Offline demo: detach a build, work meanwhile, harvest on a later turn ───
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  const call = (name: string, args: Record<string, unknown>): OutputItem => ({
    type: "function_call", id: `call_${ran}`, call_id: `call_${ran}`, name, arguments: JSON.stringify(args),
  });
  const script: Array<[string, Record<string, unknown>]> = [
    ["run_background", { command: "sleep 1.5 && echo 'build artifacts ready'" }], // detached
    ["shell", { command: "echo 'meanwhile: reading package.json'" }],              // fast, sync
    ["check_background", { id: "bg_1" }],                                          // too soon → running
    ["shell", { command: "sleep 2 && echo 'meanwhile: ran the linter'" }],         // more work
    ["check_background", { id: "bg_1" }],                                          // now → done, harvest
  ];
  if (ran < script.length) return [call(...script[ran])];
  return [{
    type: "message",
    content: [{ type: "output_text", text:
      `[offline demo] I detached the slow build with run_background (got bg_1) instead of ` +
      `blocking on it. While it ran, I did two fast foreground tasks. My first check_background ` +
      `came back "still running"; after more work, the second check harvested the output — ` +
      `"build artifacts ready". I never sat idle waiting. Set OPENAI_API_KEY for a real model.` }],
  }];
}

// ── The agent loop: s01's loop + a dispatch map (from s02) ──────────────────
async function agentLoop(input: unknown[]): Promise<void> {
  for (;;) {
    const output = await callModel(input);
    input.push(...output);

    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output) {
        if (item.type === "message") {
          for (const c of item.content ?? []) if (c.type === "output_text" && c.text) console.log(c.text);
        }
      }
      return;
    }
    for (const call of calls) {
      const handler = DISPATCH[call.name ?? ""];
      const result = handler
        ? await handler(JSON.parse(call.arguments ?? "{}") as Record<string, unknown>)
        : `Error: unknown tool ${call.name}`;
      if (call.name !== "shell") console.log(`\x1b[90m→ ${result.split("\n")[0]}\x1b[0m`);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL (async-iterator, robust to piped stdin) ──────
async function main(): Promise<void> {
  console.log("s13: Async Background Execution (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a goal with a slow step, or q to quit.\n"
      : `Model: ${MODEL}. Type a goal with a slow step, or q to quit.\n`
  );
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const thread: unknown[] = [];
  process.stdout.write("\x1b[36ms13 >> \x1b[0m");
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
    process.stdout.write("\x1b[36ms13 >> \x1b[0m");
  }
  rl.close();
}

main();
