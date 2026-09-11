#!/usr/bin/env tsx
/**
 * s02_tool_use/code.ts — Tool Registry & Dispatch Map (Codex-style, in TypeScript)
 *
 * s01 gave the model ONE tool (shell). A real agent hands it a *set* of structured
 * tools and a dispatch map that routes each call by name:
 *
 *     model returns function_call { name, arguments }
 *         |
 *         v
 *     handler = TOOL_HANDLERS[name]        // look the name up
 *     output  = handler(JSON.parse(arguments))
 *
 *     +--------+      one turn, several calls      +-----------------------+
 *     | Model  | --------------------------------> | read_file  a.ts       |
 *     | (loop) | --------------------------------> | write_file b.ts       |
 *     +--------+ --------------------------------> | list_dir   src/       |
 *            ^                                     +----------+------------+
 *            |   each result fed back as a function_call_output
 *            +------------------------------------------------+
 *
 * Adding a tool = one entry in TOOLS (the schema the model sees) + one entry in
 * TOOL_HANDLERS (the function the harness runs). The agent loop never changes.
 *
 * The star of the registry is apply_patch. Codex steers the model to edit files
 * with a structured patch instead of `sed`/`echo`, because a patch is one
 * reviewable, atomic, all-or-nothing unit:
 *
 *     *** Begin Patch
 *     *** Update File: a.md        (optional) *** Move to: b.md
 *     @@                            hunk header — anchors the change
 *      context / -removed / +added  lines prefixed by space / - / +
 *     *** Add File: c.md           the following +lines become the file
 *     *** Delete File: d.md
 *     *** End Patch
 *
 * The whole patch is parsed before a single byte is written, and every update is
 * matched against the file's current content before commit — so it either applies
 * cleanly or fails with a precise error, never a half-written file.
 *
 * Each turn prints the raw `output` array, then the harness line for each call.
 * Offline mode ignores the prompt and writes .tmp/s02/ (same story as the web
 * simulator): one turn fans out writes, the next fans out apply_patch ×2 /
 * read_file / list_dir — one patch commits, one is rejected atomically.
 *
 * Run it:
 *     npm install
 *     npx tsx s02_tool_use/code.ts          # offline demo model (no key needed)
 *     OPENAI_API_KEY=sk-... npx tsx s02_tool_use/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const TMP_DIR = path.join(CWD, ".tmp", "s02");
const ALPHA_REL = path.join(".tmp", "s02", "alpha.md");
const BETA_REL = path.join(".tmp", "s02", "beta.md");
const USAGE_REL = path.join(".tmp", "s02", "usage.md");
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const MODEL_LABEL = OFFLINE ? "offline" : MODEL;

const INSTRUCTIONS =
  `You are a coding agent in ${CWD}. Prefer the structured tools (read_file, ` +
  `write_file, apply_patch, list_dir) over raw shell for file work. Act, don't explain.`;

const resolvePath = (p: string): string => path.resolve(CWD, p);

// ── NEW in s02: a registry of structured tools ───────────────────────────
// The schemas the model sees — one Responses API function tool per capability.
const TOOLS = [
  {
    type: "function" as const,
    name: "read_file",
    description: "Read a UTF-8 file and return its text (optionally the first N lines).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the workspace." },
        limit: { type: "number", description: "Optional max number of lines to return." },
      },
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
      properties: {
        path: { type: "string", description: "Path to the file, relative to the workspace." },
        content: { type: "string", description: "The full content to write." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "apply_patch",
    // We expose apply_patch as an ordinary function tool (a JSON {patch} string).
    // The real Codex instead exposes it as a *freeform* custom tool whose raw body
    // is grammar-constrained to this exact format, so the model cannot emit a
    // malformed patch. That behavior used to sit behind the `apply_patch_freeform`
    // feature flag; in current Codex (v0.144.x) `codex features list` shows that
    // flag as "removed" — the grammar-constrained freeform form has graduated to
    // be the standard behavior. See runApplyPatch for the grammar.
    description:
      "Edit files with a Codex-style patch. Grammar: '*** Begin Patch', then one " +
      "or more of '*** Add File: <path>' (following '+' lines are the content), " +
      "'*** Delete File: <path>', '*** Update File: <path>' (optional '*** Move to: " +
      "<path>', then '@@' hunk headers and lines prefixed ' '/'-'/'+' for context / " +
      "removed / added, '*** End of File' anchors at EOF), and finally '*** End Patch'.",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "*** Begin Patch ... *** Add/Update/Delete File: <path> ... *** End Patch",
        },
      },
      required: ["patch"],
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
      properties: {
        path: { type: "string", description: "Directory to list, relative to the workspace." },
      },
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
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ── Tool implementations ──────────────────────────────────────────────────
function runReadFile(p: string, limit?: number): string {
  const lines = fs.readFileSync(resolvePath(p), "utf8").split("\n");
  const body = limit ? lines.slice(0, limit) : lines;
  return body.join("\n").slice(0, 50_000) || "(empty file)";
}

function runWriteFile(p: string, content: string): string {
  const file = resolvePath(p);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return `Wrote ${content.length} bytes to ${p}`;
}

function runListDir(p: string): string {
  const entries = fs.readdirSync(resolvePath(p), { withFileTypes: true });
  const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  return names.join("\n") || "(empty directory)";
}

// ── NEW in s02: a faithful Codex-style apply_patch ─────────────────────────
// The real grammar (codex-rs `apply-patch`) is a tiny line-oriented DSL. Two
// properties matter more than the syntax: the whole patch is PARSED before any
// byte is written, and every update is matched against the file's current content
// BEFORE commit — so a patch is reviewable, atomic, and fails cleanly.
interface FileOp {
  kind: "add" | "delete" | "update";
  path: string;
  moveTo?: string;
  added: string[]; // add: the new file's lines
  hunks: { old: string[]; new: string[] }[]; // update: context-anchored edits
}

const isFileMark = (l: string): boolean =>
  l.startsWith("*** Add File: ") ||
  l.startsWith("*** Update File: ") ||
  l.startsWith("*** Delete File: ") ||
  l.startsWith("*** End Patch");

// Phase 0: turn the patch text into structured ops. A malformed line rejects the
// WHOLE patch — nothing is written. (This is the "grammar" the freeform tool
// constrains the model to emit.)
function parsePatch(patch: string): FileOp[] {
  const lines = patch.split("\n");
  const ops: FileOp[] = [];
  let i = lines[0]?.trim() === "*** Begin Patch" ? 1 : 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("*** End Patch")) break;
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      const added: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("*** "); i++) {
        if (lines[i].startsWith("+")) added.push(lines[i].slice(1));
        else if (lines[i].trim() !== "") throw new Error(`Add File ${path}: content lines must start with '+'`);
      }
      ops.push({ kind: "add", path, added, hunks: [] });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      ops.push({ kind: "delete", path: line.slice("*** Delete File: ".length).trim(), added: [], hunks: [] });
      i++;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const op: FileOp = { kind: "update", path: line.slice("*** Update File: ".length).trim(), added: [], hunks: [] };
      i++;
      if ((lines[i] ?? "").startsWith("*** Move to: ")) {
        op.moveTo = lines[i].slice("*** Move to: ".length).trim();
        i++;
      }
      let cur = { old: [] as string[], new: [] as string[] };
      const flush = (): void => {
        if (cur.old.length || cur.new.length) op.hunks.push(cur);
        cur = { old: [], new: [] };
      };
      for (; i < lines.length && !isFileMark(lines[i]); i++) {
        const l = lines[i];
        if (l.startsWith("*** End of File") || l.startsWith("@@")) { flush(); continue; } // hunk boundary / EOF anchor
        if (l.startsWith("-")) cur.old.push(l.slice(1));
        else if (l.startsWith("+")) cur.new.push(l.slice(1));
        else if (l === "" || l.startsWith(" ")) { const c = l === "" ? "" : l.slice(1); cur.old.push(c); cur.new.push(c); } // context
        else throw new Error(`Update File ${op.path}: bad hunk line '${l}'`);
      }
      flush();
      ops.push(op);
      continue;
    }
    if (line.trim() === "") { i++; continue; } // tolerate blank lines between ops
    throw new Error(`unrecognized patch line '${line}'`);
  }
  return ops;
}

function runApplyPatch(patch: string): string {
  let ops: FileOp[];
  try {
    ops = parsePatch(patch);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : err}`; // rejected wholesale — nothing written
  }
  if (ops.length === 0) return "Error: empty patch";

  // Phase 1: compute every file's fate in memory; bail on the first bad op.
  const writes = new Map<string, string | null>(); // null → delete
  const done: string[] = [];
  for (const op of ops) {
    if (op.kind === "add") {
      if (fs.existsSync(resolvePath(op.path))) return `Error: already exists ${op.path}`;
      writes.set(op.path, op.added.join("\n") + "\n");
      done.push(`added ${op.path}`);
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(resolvePath(op.path), "utf8");
    } catch {
      return `Error: cannot read ${op.path}`;
    }
    if (op.kind === "delete") {
      writes.set(op.path, null);
      done.push(`deleted ${op.path}`);
      continue;
    }
    for (const h of op.hunks) {
      const oldBlock = h.old.join("\n");
      if (oldBlock === "") text = text.replace(/\n?$/, `\n${h.new.join("\n")}\n`); // pure insertion → append
      else if (!text.includes(oldBlock)) return `Error: context not found in ${op.path}`;
      else text = text.replace(oldBlock, h.new.join("\n"));
    }
    if (op.moveTo) {
      writes.set(op.path, null);
      done.push(`moved ${op.path} -> ${op.moveTo}`);
    }
    writes.set(op.moveTo ?? op.path, text);
    done.push(`updated ${op.moveTo ?? op.path}`);
  }

  // Phase 2: every op validated — only now touch disk.
  for (const [p, content] of writes) {
    if (content === null) fs.rmSync(resolvePath(p));
    else runWriteFile(p, content);
  }
  return `Patch applied: ${done.join(", ")}`;
}

function runShell(command: string): string {
  // Teaching guardrail only. s03/s04 build the real approval + sandbox.
  const dangerous = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: dangerous command blocked";
  }
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

// ── NEW in s02: the dispatch map — tool name -> handler ──────────────────
// Adding a tool is ONE line here (plus its schema in TOOLS above).
type Args = Record<string, unknown> & { path?: string; command?: string; patch?: string };
const TOOL_HANDLERS: Record<string, (a: Args) => string> = {
  read_file: (a) => runReadFile(String(a.path), a.limit as number | undefined),
  write_file: (a) => runWriteFile(String(a.path), String(a.content)),
  apply_patch: (a) => runApplyPatch(String(a.patch)),
  list_dir: (a) => runListDir(String(a.path)),
  shell: (a) => runShell(String(a.command)),
};

function dispatch(name: string, argsJson: string): string {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return `Error: unknown tool '${name}'`;
  try {
    return handler(JSON.parse(argsJson) as Args);
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Model adapter (same shape as s01: Responses API output items) ─────────
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

const SCRIPT_TOOL_COUNT = 7; // turn 1: 3 calls, turn 2: 4 calls

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
  const isDotEntry = (line: string) => {
    const name = line.trimEnd().split(/\s+/).pop();
    return name === "." || name === "..";
  };
  const visible = all.filter((line) => !isDotEntry(line));
  if (result === "(no output)" || result === "") {
    console.log(dim("  │ （成功，无 stdout。echo > 文件时很常见）"));
    return;
  }
  const shown = visible.slice(0, maxLines);
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
  console.log(dim("  harness 执行:"));
  if (call.name === "shell") {
    console.log(yellow(`  $ ${String(args.command ?? "")}`));
    return;
  }
  if (call.name === "apply_patch") {
    console.log(yellow("  apply_patch"));
    const lines = String(args.patch ?? "").split("\n");
    const shown = lines.slice(0, 16);
    for (const line of shown) console.log(dim(`  │ ${line}`));
    if (lines.length > shown.length) {
      console.log(dim(`  │ … ${lines.length - shown.length} more lines`));
    }
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
// Ignores the user text. Plays once per process; later prompts do not re-run tools.
function offlineModel(input: unknown[]): OutputItem[] {
  fs.mkdirSync(TMP_DIR, { recursive: true });
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
              `[offline demo] 这条进程里的固定剧本已经演完（写两个文件 → 补丁成功/失败 → 核对）。` +
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
      call(`call_${turn}_1`, "write_file", { path: ALPHA_REL, content: "# Alpha\n" }),
      call(`call_${turn}_2`, "write_file", { path: BETA_REL, content: "# Beta\n" }),
      call(`call_${turn}_3`, "shell", { command: "echo 'scratch workspace ready'" }),
    ];
  }
  if (ran === 3) {
    return [
      // A structured patch using the real grammar: envelope, @@ hunk header, a
      // context line (space prefix), added lines (+), and an Add File op.
      call(`call_${turn}_4`, "apply_patch", {
        patch:
          "*** Begin Patch\n" +
          `*** Update File: ${ALPHA_REL}\n` +
          "@@\n" +
          " # Alpha\n" +
          "+\n" +
          "+Patched by apply_patch.\n" +
          `*** Add File: ${USAGE_REL}\n` +
          "+# Usage\n" +
          "*** End Patch",
      }),
      // A patch whose context does NOT match the file: the WHOLE patch is
      // rejected before any byte is written — atomicity / failure recovery.
      call(`call_${turn}_5`, "apply_patch", {
        patch:
          "*** Begin Patch\n" +
          `*** Update File: ${ALPHA_REL}\n` +
          "@@\n" +
          " this line is not in the file\n" +
          "-# Alpha\n" +
          "+# ALPHA\n" +
          "*** End Patch",
      }),
      call(`call_${turn}_6`, "read_file", { path: ALPHA_REL }),
      call(`call_${turn}_7`, "list_dir", { path: path.join(".tmp", "s02") }),
    ];
  }
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text:
            `[offline demo] 已写入 ${ALPHA_REL} / ${BETA_REL}，第一份补丁落地（改 alpha、加 usage），` +
            `第二份因上下文对不上被整体拒绝——上面的 read_file 证明 alpha.md 没被改坏。` +
            `这是固定剧本，不是在回答你刚打的字。设 OPENAI_API_KEY 后，工具才会跟着问题变——循环和 dispatch 不变。`,
        },
      ],
    },
  ];
}

// ── The agent loop: identical to s01, only the execution line changes ──────
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
          : "[offline] 不读你刚打的字。固定演示：一轮写出两个文件 → 一轮补丁（成功+失败）→ 核对。"
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
      console.log(dim(`  本轮 ${calls.length} 个 function_call → 同一轮 fan-out，按 name 查表`));
    }
    for (const call of calls) {
      printHarnessCall(call);
      const result = dispatch(call.name ?? "", call.arguments ?? "{}"); // s02: table lookup
      previewToolOutput(result);
      console.log(green("  已写回 function_call_output → continue"));
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL ───────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s02: Tool Registry & Dispatch Map (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a task, or q to quit."
      : `Model: ${MODEL}. Type a task, or q to quit.`
  );
  console.log(
    dim(
      OFFLINE
        ? "output: 是返回值。harness 按 name 查表执行。没 key：不读提示词，固定演示写入 .tmp/s02/。\n"
        : "output: 是返回值。harness 按 name 查表执行。\n"
    )
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];

  for (;;) {
    const query = await new Promise<string>((resolve) =>
      rl.question("\x1b[36ms02 >> \x1b[0m", resolve)
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
