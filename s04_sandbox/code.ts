#!/usr/bin/env tsx
/**
 * s04_sandbox/code.ts — sandbox_mode: a Hard Boundary at Execution (Codex-style)
 *
 * Approval (s03) decides whether to ASK; the sandbox decides what a call can
 * TOUCH — enforced even after a "yes". Codex exposes it as `sandbox_mode`:
 *
 *     function_call
 *         |
 *         v
 *     sandbox layer intercepts the call
 *         |
 *         v
 *     sandbox_mode:
 *       read-only          -> refuse every write / mutation
 *       workspace-write    -> allow writes INSIDE the workspace, refuse outside
 *       danger-full-access -> allow everything (no boundary)
 *         |
 *    refused? -> feed an error item back to the model (the loop goes on)
 *
 * The teaching sandbox is a userspace path-check. The REAL backend is the OS:
 * Seatbelt on macOS, Landlock on Linux (see the README deep-dive).
 *
 * Run it:
 *     npm install
 *     npx tsx s04_sandbox/code.ts                       # offline demo (workspace-write)
 *     SANDBOX_MODE=read-only npx tsx s04_sandbox/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s04_sandbox/code.ts # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

// ── NEW in s04: sandbox_mode ──────────────────────────────────────────────
// The writable root under workspace-write is the directory you launched from.
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
const MODE: SandboxMode = (process.env.SANDBOX_MODE as SandboxMode) ?? "workspace-write";
const WORKSPACE = CWD;

const INSTRUCTIONS =
  `You are a coding agent in ${CWD}. Use the tools to solve the task. ` +
  `If the sandbox refuses a call, accept it and work inside the workspace.`;

// ── Tools (the s02 registry; the sandbox wraps dispatch, not the tools) ────
const TOOLS = [
  {
    type: "function" as const,
    name: "read_file",
    description: "Read a UTF-8 file and return its text.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "write_file",
    description: "Write content to a file, creating parent directories as needed.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "list_dir",
    description: "List the entries of a directory, one per line.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "shell",
    description: "Run a shell command and return its combined stdout+stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const resolvePath = (p: string): string => path.resolve(CWD, p);
function runReadFile(p: string): string {
  return fs.readFileSync(resolvePath(p), "utf8").slice(0, 50_000) || "(empty file)";
}
function runWriteFile(p: string, content: string): string {
  const f = resolvePath(p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return `Wrote ${content.length} bytes to ${p}`;
}
function runListDir(p: string): string {
  const entries = fs.readdirSync(resolvePath(p), { withFileTypes: true });
  return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
}
function runShell(command: string): string {
  try {
    const out = execSync(command, { cwd: CWD, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return (String(out).trim() || "(no output)").slice(0, 50_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

type Args = Record<string, unknown> & { path?: string; command?: string };
const TOOL_HANDLERS: Record<string, (a: Args) => string> = {
  read_file: (a) => runReadFile(String(a.path)),
  write_file: (a) => runWriteFile(String(a.path), String(a.content)),
  list_dir: (a) => runListDir(String(a.path)),
  shell: (a) => runShell(String(a.command)),
};

// ── NEW in s04: the sandbox layer ─────────────────────────────────────────
// What does this call want to write, and where? (a teaching-grade heuristic)
const isInside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// Candidate absolute/outside paths a shell command tries to touch.
function shellTargets(cmd: string): string[] {
  return cmd
    .split(/\s+/)
    .filter((t) => /^(\/|~|\.\.)/.test(t))
    .map((t) => path.resolve(CWD, t.replace(/^~/, os.homedir())));
}
const SHELL_WRITES = [">>", ">", "tee ", "rm ", "mv ", "cp ", "mkdir", "touch", "chmod", "chown", "sed -i", "ln "];

type Verdict = { ok: true } | { ok: false; reason: string };
const ALLOW: Verdict = { ok: true };
const refuse = (reason: string): Verdict => ({ ok: false, reason });

function sandboxCheck(call: OutputItem, args: Args): Verdict {
  if (MODE === "danger-full-access") return ALLOW; // no boundary at all
  const name = call.name ?? "";

  // read-only tools never write: always allowed (any mode).
  if (name === "read_file" || name === "list_dir") return ALLOW;

  if (name === "write_file") {
    const target = resolvePath(String(args.path));
    if (MODE === "read-only") return refuse("read-only sandbox: writes are disabled");
    if (!isInside(WORKSPACE, target)) return refuse(`write outside workspace: ${target}`);
    return ALLOW;
  }

  if (name === "shell") {
    const cmd = String(args.command ?? "");
    const mutates = SHELL_WRITES.some((op) => cmd.includes(op));
    if (MODE === "read-only") {
      return mutates ? refuse("read-only sandbox: command may write") : ALLOW;
    }
    // workspace-write: refuse if any path token points outside the workspace.
    const escape = shellTargets(cmd).find((t) => !isInside(WORKSPACE, t));
    if (escape) return refuse(`command touches outside workspace: ${escape}`);
    return ALLOW;
  }
  return ALLOW;
}

// The sandbox WRAPS dispatch: intercept, check, then (maybe) run.
function sandboxedDispatch(call: OutputItem): string {
  const args = JSON.parse(call.arguments ?? "{}") as Args;
  const verdict = sandboxCheck(call, args);
  if (!verdict.ok) return `Error: blocked by sandbox_mode=${MODE}: ${verdict.reason}`;
  try {
    return TOOL_HANDLERS[call.name ?? ""]?.(args) ?? `Error: unknown tool '${call.name}'`;
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Model adapter (Responses API output items, online or offline) ─────────
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

// Offline scripted model: one turn that writes INSIDE the workspace, reads it
// back, tries to write OUTSIDE (../), and writes via shell — so you can watch
// the sandbox allow the inside writes and refuse the escape.
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  const call = (id: string, name: string, args: Record<string, unknown>): OutputItem => ({
    type: "function_call",
    id,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  });
  if (ran === 0) {
    return [
      call("c1", "write_file", { path: "agent_scratch/note.md", content: "inside the workspace\n" }),
      call("c2", "read_file", { path: "agent_scratch/note.md" }),
      call("c3", "write_file", { path: "../s04_outside.txt", content: "escape the workspace!\n" }),
      call("c4", "shell", { command: "echo hi > agent_scratch/shell.txt" }),
    ];
  }
  const blocked = input.filter((i) =>
    (i as { output?: string }).output?.includes("blocked by sandbox_mode")
  ).length;
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text:
            `[offline demo] sandbox_mode=${MODE}: the model tried 4 calls in one turn — ` +
            `${blocked} were refused by the sandbox and returned as error items; the rest ran. ` +
            `Try SANDBOX_MODE=read-only|danger-full-access. Set OPENAI_API_KEY for a real model.`,
        },
      ],
    },
  ];
}

// ── The agent loop: s02's dispatch, now behind the sandbox layer ──────────
async function agentLoop(input: unknown[]): Promise<void> {
  for (;;) {
    const output = await callModel(input);
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
      const args = JSON.parse(call.arguments ?? "{}") as Args;
      const verdict = sandboxCheck(call, args);
      const tag = verdict.ok ? "\x1b[32m✓ allow\x1b[0m" : `\x1b[31m✗ ${verdict.reason}\x1b[0m`;
      console.log(`\x1b[33m-> ${call.name}(${summarize(call.arguments ?? "")})\x1b[0m ${tag}`);
      const result = sandboxedDispatch(call); // NEW in s04: dispatch behind the sandbox
      console.log(result.split("\n").slice(0, 5).join("\n"));
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

function summarize(argsJson: string): string {
  try {
    const a = JSON.parse(argsJson) as Args;
    return String(a.path ?? a.command ?? "").slice(0, 60);
  } catch {
    return argsJson.slice(0, 60);
  }
}

// ── Entry point: a minimal REPL ───────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s04: sandbox_mode — a Hard Boundary at Execution (Codex-style)");
  console.log(
    OFFLINE
      ? `Offline demo model (no OPENAI_API_KEY). sandbox_mode=${MODE}. Type a task, or q to quit.\n`
      : `Model: ${MODEL}. sandbox_mode=${MODE}. Type a task, or q to quit.\n`
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];
  for (;;) {
    const query = await new Promise<string>((resolve) =>
      rl.question("\x1b[36ms04 >> \x1b[0m", resolve)
    );
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase()) ) break;
    thread.push({ role: "user", content: query });
    try {
      await agentLoop(thread);
    } catch (err) {
      console.error("agent error:", err);
    }
    console.log();
  }
  rl.close();
}

main();
