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
 * Each turn prints the raw `output` array, then the sandbox verdict, then
 * dispatch. Offline mode ignores the prompt and writes .tmp/s04/ (same story
 * as the web simulator): inside write + read, a `../` escape, and a shell
 * write — workspace-write allows the inside calls and refuses the escape.
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
const TMP_DIR = path.join(CWD, ".tmp", "s04");
const NOTE_REL = path.join(".tmp", "s04", "note.md");
const SHELL_REL = path.join(".tmp", "s04", "shell.txt");
const OUTSIDE_REL = path.join("..", "s04_outside.txt");
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const MODEL_LABEL = OFFLINE ? "offline" : MODEL;

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
    const out = execSync(command, {
      cwd: CWD,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const SCRIPT_TOOL_COUNT = 4; // one turn: inside write, read, ../ escape, shell write

function countToolResults(input: unknown[]): number {
  return input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
}

function countToolResultsSinceLastUser(input: unknown[]): number {
  let lastUser = -1;
  for (let i = 0; i < input.length; i++) {
    if ((input[i] as { role?: string }).role === "user") lastUser = i;
  }
  return input
    .slice(lastUser + 1)
    .filter((i) => (i as { type?: string }).type === "function_call_output").length;
}

function printOutput(output: OutputItem[]): void {
  const json = JSON.stringify(
    output,
    (_key, value) =>
      typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…` : value,
    2,
  );
  console.log(dim("  output:"));
  for (const line of json.split("\n")) console.log(dim(`  ${line}`));
}

function previewToolOutput(result: string, maxLines = 20): void {
  const all = result.split("\n");
  if (result === "(no output)" || result === "") {
    console.log(dim("  │ （成功，无 stdout）"));
    return;
  }
  const shown = all.slice(0, maxLines);
  for (const line of shown) console.log(dim(`  │ ${line}`));
  const hidden = all.length - shown.length;
  if (hidden > 0) {
    console.log(dim(`  │ … ${hidden} more lines（完整结果在 thread 里）`));
  }
}

function printHarnessCall(call: OutputItem): void {
  let args: Args = {};
  try {
    args = JSON.parse(call.arguments ?? "{}") as Args;
  } catch {
    args = {};
  }
  console.log(dim("  harness:"));
  if (call.name === "shell") {
    console.log(yellow(`  $ ${String(args.command ?? "")}`));
    return;
  }
  const pathArg = args.path != null ? `  path=${args.path}` : "";
  console.log(yellow(`  ${call.name ?? "?"}${pathArg}`));
}

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

// Scripted stand-in: same story as the web simulator.
// Ignores the user text. One turn: write inside, read back, write via ../, shell write.
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = countToolResultsSinceLastUser(input);
  const alreadyPlayed = countToolResults(input) >= SCRIPT_TOOL_COUNT && ran === 0;
  const turn = input.filter((i) => (i as { role?: string }).role === "user").length;

  const call = (id: string, name: string, args: Record<string, unknown>): OutputItem => ({
    type: "function_call",
    id,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  });

  if (alreadyPlayed) {
    return [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text:
              `[offline demo] 这条进程里的固定剧本已经演完（界内写 ${NOTE_REL} → 读回 → 越界写 ${OUTSIDE_REL} → shell 写入）。` +
              `刚才不是听懂了你的话。输入 q 退出；设 OPENAI_API_KEY 后工具才会跟着问题变。`,
          },
        ],
      },
    ];
  }

  if (ran === 0) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
    return [
      call(`call_${turn}_1`, "write_file", { path: NOTE_REL, content: "inside the workspace\n" }),
      call(`call_${turn}_2`, "read_file", { path: NOTE_REL }),
      call(`call_${turn}_3`, "write_file", { path: OUTSIDE_REL, content: "escape the workspace!\n" }),
      call(`call_${turn}_4`, "shell", { command: `echo hi > ${SHELL_REL}` }),
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
            `[offline demo] sandbox_mode=${MODE}：同一轮 4 个调用——界内写 ${NOTE_REL}、读回、越界写 ${OUTSIDE_REL}、shell 写入 ${SHELL_REL}。` +
            `${blocked} 个被沙箱拒绝并喂回错误 item；其余已执行。` +
            `这是固定剧本，不是在回答你刚打的字。试 SANDBOX_MODE=read-only|danger-full-access。` +
            `设 OPENAI_API_KEY 后，工具才会跟着问题变——循环和 dispatch 不变，只是 dispatch 外包了这层沙箱。`,
        },
      ],
    },
  ];
}

// ── The agent loop: s02's dispatch, now behind the sandbox layer ──────────
async function agentLoop(input: unknown[]): Promise<void> {
  const lastUser = [...input].reverse().find((i) => (i as { role?: string }).role === "user") as
    | { content?: unknown }
    | undefined;
  if (typeof lastUser?.content === "string") console.log(dim(`  user: ${lastUser.content}`));
  if (OFFLINE) {
    const replay = countToolResults(input) >= SCRIPT_TOOL_COUNT;
    console.log(
      dim(
        replay
          ? "[offline] 剧本已演过，不再重复执行工具。"
          : `[offline] 不读你刚打的字。固定演示：界内写/读 ${NOTE_REL} + 越界 ${OUTSIDE_REL} + shell 写入。mode=${MODE}`
      )
    );
  }
  let turn = 0;
  for (;;) {
    turn += 1;
    const output = await callModel(input);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    console.log(cyan(`── turn ${turn} ──`));
    console.log(dim(`  模型: ${MODEL_LABEL}`));
    printOutput(output);

    if (calls.length === 0) {
      for (const item of output) {
        if (item.type === "message") {
          for (const part of item.content ?? []) {
            if (part.type === "output_text" && part.text) console.log("message: " + part.text);
          }
        }
      }
      return;
    }

    if (calls.length > 1) {
      console.log(dim(`  本轮 ${calls.length} 个 function_call → 同一轮 fan-out，每个都先过沙箱再 dispatch`));
    }

    for (const call of calls) {
      const args = JSON.parse(call.arguments ?? "{}") as Args;
      const verdict = sandboxCheck(call, args);
      printHarnessCall(call);
      if (verdict.ok) {
        console.log(dim(`  sandbox: mode=${MODE}  allow`));
      } else {
        console.log(red(`  sandbox: mode=${MODE}  refuse — ${verdict.reason}`));
      }
      const result = sandboxedDispatch(call); // NEW in s04: dispatch behind the sandbox
      previewToolOutput(result);
      console.log(
        verdict.ok
          ? green("  已写回 function_call_output → continue")
          : red("  已写回 function_call_output（blocked）→ continue")
      );
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL ───────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s04: sandbox_mode — a Hard Boundary at Execution (Codex-style)");
  console.log(
    OFFLINE
      ? `Offline demo model (no OPENAI_API_KEY). sandbox_mode=${MODE}. Type a task, or q to quit.`
      : `Model: ${MODEL}. sandbox_mode=${MODE}. Type a task, or q to quit.`
  );
  console.log(
    dim(
      OFFLINE
        ? "output: 是返回值。dispatch 外包一层沙箱。没 key：不读提示词，固定演示写入 .tmp/s04/ 并尝试 ../ 越界。\n"
        : "output: 是返回值。dispatch 外包一层沙箱。\n"
    )
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];
  for (;;) {
    const query = await new Promise<string>((resolve) =>
      rl.question("\x1b[36ms04 >> \x1b[0m", resolve)
    );
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;
    thread.push({ role: "user", content: query });
    console.log();
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
