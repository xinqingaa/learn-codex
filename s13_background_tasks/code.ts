#!/usr/bin/env tsx
/**
 * s13_background_tasks/code.ts — unified_exec (Codex-style, TS)
 *
 * Codex does not detach with a fire-and-forget id. Slow commands go through
 * unified_exec: wait a yield window, then either return the result or a
 * session_id the model later harvests with write_stdin.
 *
 *     exec_command(cmd, yield_time_ms)
 *          │  spawn child, wait up to the yield window
 *          ├─ finished in time  → output + exit_code
 *          └─ still running     → session_id + snapshot so far
 *                                      │
 *               model does other work  │  child keeps running
 *                                      ▼
 *     write_stdin(session_id, chars: "")  → another yield window → harvest
 *
 * Client EventMsg (Begin/End) is printed for the UI. It is not pushed into
 * the model; the model only sees tool results. The loop is still s01's.
 *
 * Run it:
 *     npm install
 *     npx tsx s13_background_tasks/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s13_background_tasks/code.ts
 */

import OpenAI from "openai";
import { execSync, spawn } from "node:child_process";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const DEFAULT_YIELD_MS = 10_000;

const INSTRUCTIONS =
  `You are a coding agent in ${CWD}. For a slow command (build, test, install), ` +
  `call exec_command with a yield_time_ms. If the result includes session_id and ` +
  `"still running", keep doing useful work with shell, then poll with ` +
  `write_stdin({ session_id, chars: "" }). Use shell for fast commands.`;

// ── NEW in s13: unified_exec — yield window, then harvest by session_id ─────
type ExecSession = {
  sessionId: number; command: string; status: "running" | "done";
  output: string; seen: number; exitCode: number | null;
};
const sessions = new Map<number, ExecSession>();
let nextSessionId = 0;
const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clampYield = (ms: number): number => Math.min(30_000, Math.max(250, ms));
const emitClient = (kind: string, detail: string): void => {
  console.log(`\x1b[35m[event] ${kind} ${detail}\x1b[0m`);
};

function spawnSession(command: string): ExecSession {
  const session: ExecSession = {
    sessionId: ++nextSessionId, command, status: "running",
    output: "", seen: 0, exitCode: null,
  };
  sessions.set(session.sessionId, session);
  emitClient("ExecCommandBegin", `session_id=${session.sessionId} cmd=${command}`);
  const child = spawn(command, { cwd: CWD, shell: true });
  child.stdout?.on("data", (d) => { session.output += String(d); });
  child.stderr?.on("data", (d) => { session.output += String(d); });
  child.on("close", (code) => {
    session.status = "done";
    session.exitCode = code ?? -1;
    emitClient("ExecCommandEnd", `session_id=${session.sessionId} exit=${session.exitCode}`);
  });
  return session;
}

async function waitYield(session: ExecSession, yieldMs: number): Promise<void> {
  const deadline = Date.now() + clampYield(yieldMs);
  while (Date.now() < deadline && session.status === "running") await tick();
}

function formatExecResult(session: ExecSession, wallMs: number): string {
  const fresh = session.output.slice(session.seen);
  session.seen = session.output.length;
  if (session.status === "done") {
    sessions.delete(session.sessionId);
    return `exit_code: ${session.exitCode}\nwall_time_ms: ${wallMs}\n--- output ---\n` +
      (fresh.trim() || session.output.trim() || "(no output)");
  }
  return `session_id: ${session.sessionId}\nwall_time_ms: ${wallMs}\nstatus: still running\n` +
    `--- output so far ---\n${fresh.trim() || "(no new output)"}\n` +
    `poll with write_stdin({ session_id: ${session.sessionId}, chars: "" })`;
}

async function execCommand(cmd: string, yieldTimeMs: number): Promise<string> {
  const dangerous = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => cmd.includes(d))) return "Error: dangerous command blocked";
  const session = spawnSession(cmd);
  const start = Date.now();
  await waitYield(session, yieldTimeMs);
  return formatExecResult(session, Date.now() - start);
}

async function writeStdin(sessionId: number, chars: string, yieldTimeMs: number): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return `Error: no such session ${sessionId}`;
  if (chars) {
    return `Error: this teaching demo only supports empty write_stdin polls; ` +
      `real Codex writes non-empty chars to the process PTY.`;
  }
  const start = Date.now();
  await waitYield(session, yieldTimeMs);
  return formatExecResult(session, Date.now() - start);
}

// ── Synchronous shell for fast commands (unchanged from earlier chapters) ───
function runShell(command: string): string {
  const dangerous = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: dangerous command blocked";
  try {
    const out = execSync(command, { cwd: CWD, timeout: 120_000, maxBuffer: 1_048_576 });
    return (String(out).trim() || "(no output)").slice(0, 50_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

const DISPATCH: Record<string, (args: Record<string, unknown>) => string | Promise<string>> = {
  shell: (a) => { console.log(`\x1b[33m$ ${String(a.command)}\x1b[0m`); return runShell(String(a.command)); },
  exec_command: (a) => execCommand(String(a.cmd), Number(a.yield_time_ms ?? DEFAULT_YIELD_MS)),
  write_stdin: (a) => writeStdin(Number(a.session_id), String(a.chars ?? ""), Number(a.yield_time_ms ?? 250)),
};

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const TOOLS = [
  { type: "function" as const, name: "shell", strict: true,
    description: "Run a fast shell command synchronously and return its output.",
    parameters: obj({ command: str("The shell command to run.") }, ["command"]) },
  { type: "function" as const, name: "exec_command", strict: true,
    description: "Run a command asynchronously. Waits up to yield_time_ms; if still running, returns session_id.",
    parameters: obj({
      cmd: str("The command to run."),
      yield_time_ms: num("How long to wait before yielding. Default 10000."),
    }, ["cmd", "yield_time_ms"]) },
  { type: "function" as const, name: "write_stdin", strict: true,
    description: "Poll (chars empty) or write to a yielded exec_command session.",
    parameters: obj({
      session_id: num("The session_id from a still-running exec_command."),
      chars: str("Empty string to poll; real Codex also writes this to the PTY."),
      yield_time_ms: num("How long to wait before yielding this poll."),
    }, ["session_id", "chars", "yield_time_ms"]) },
];

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

// ── Offline demo: yield a build, work meanwhile, harvest on a later turn ────
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  const call = (name: string, args: Record<string, unknown>): OutputItem => ({
    type: "function_call", id: `call_${ran}`, call_id: `call_${ran}`, name, arguments: JSON.stringify(args),
  });
  const script: Array<[string, Record<string, unknown>]> = [
    ["exec_command", { cmd: "sleep 1.5 && echo 'build artifacts ready'", yield_time_ms: 400 }],
    ["shell", { command: "echo 'meanwhile: reading package.json'" }],
    ["write_stdin", { session_id: 1, chars: "", yield_time_ms: 400 }],
    ["shell", { command: "sleep 2 && echo 'meanwhile: ran the linter'" }],
    ["write_stdin", { session_id: 1, chars: "", yield_time_ms: 400 }],
  ];
  if (ran < script.length) return [call(...script[ran])];
  return [{
    type: "message",
    content: [{ type: "output_text", text:
      `[offline demo] exec_command waited a yield window and came back still running ` +
      `with session_id 1. I kept working with shell. The first write_stdin was still ` +
      `running; after more work, the second harvested "build artifacts ready". The ` +
      `[event] lines were for the client, not pushed into me. Set OPENAI_API_KEY for a real model.` }],
  }];
}

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

async function main(): Promise<void> {
  console.log("s13: unified_exec — yield, then harvest");
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
    try { await agentLoop(thread); } catch (err) {
      console.error("agent error:", err instanceof Error ? err.message : err);
    }
    console.log();
    process.stdout.write("\x1b[36ms13 >> \x1b[0m");
  }
  rl.close();
}

main();
