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
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

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
  try {
    const out = execSync(command, { cwd: CWD, timeout: 120_000, maxBuffer: 1024 * 1024 });
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

// Offline scripted model: it fans out several tool calls in a single turn, twice,
// so you can watch the dispatch map route each call by name. The second turn shows
// one patch that commits and one whose stale context is rejected atomically.
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
      call("c1", "write_file", { path: "agent_scratch/alpha.md", content: "# Alpha\n" }),
      call("c2", "write_file", { path: "agent_scratch/beta.md", content: "# Beta\n" }),
      call("c3", "shell", { command: "echo 'scratch workspace ready'" }),
    ];
  }
  if (ran === 3) {
    return [
      // A structured patch using the real grammar: envelope, @@ hunk header, a
      // context line (space prefix), added lines (+), and an Add File op.
      call("c4", "apply_patch", {
        patch:
          "*** Begin Patch\n" +
          "*** Update File: agent_scratch/alpha.md\n" +
          "@@\n" +
          " # Alpha\n" +
          "+\n" +
          "+Patched by apply_patch.\n" +
          "*** Add File: agent_scratch/usage.md\n" +
          "+# Usage\n" +
          "*** End Patch",
      }),
      // A patch whose context does NOT match the file: the WHOLE patch is
      // rejected before any byte is written — atomicity / failure recovery.
      call("c5", "apply_patch", {
        patch:
          "*** Begin Patch\n" +
          "*** Update File: agent_scratch/alpha.md\n" +
          "@@\n" +
          " this line is not in the file\n" +
          "-# Alpha\n" +
          "+# ALPHA\n" +
          "*** End Patch",
      }),
      call("c6", "read_file", { path: "agent_scratch/alpha.md" }),
      call("c7", "list_dir", { path: "agent_scratch" }),
    ];
  }
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text:
            `[offline demo] One turn produced several tool calls at once, twice — the ` +
            `dispatch map routed each by name (write_file/shell, then apply_patch x2 / ` +
            `read_file / list_dir). The first apply_patch used the real '*** Begin Patch ... ` +
            `*** End Patch' grammar (an @@-anchored update + an Add File) and committed ` +
            `atomically. The second apply_patch had context that did not match alpha.md, so ` +
            `the WHOLE patch was rejected before a single byte was written — the read above ` +
            `shows alpha.md still intact. That is why Codex prefers a structured patch: ` +
            `reviewable, atomic, and it fails cleanly. Set OPENAI_API_KEY for a real model; ` +
            `the loop and dispatch stay the same.`,
        },
      ],
    },
  ];
}

// ── The agent loop: identical to s01, only the execution line changes ──────
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

    if (calls.length > 1) {
      console.log(`\x1b[35m~ fan-out: ${calls.length} tool calls in ONE turn\x1b[0m`);
    }
    for (const call of calls) {
      console.log(`\x1b[33m-> ${call.name}(${summarize(call.arguments ?? "")})\x1b[0m`);
      const result = dispatch(call.name ?? "", call.arguments ?? "{}"); // s02: table lookup
      console.log(result.split("\n").slice(0, 6).join("\n"));
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

function summarize(argsJson: string): string {
  try {
    const a = JSON.parse(argsJson) as Args;
    return String(a.path ?? a.command ?? "(patch)").slice(0, 60);
  } catch {
    return argsJson.slice(0, 60);
  }
}

// ── Entry point: a minimal REPL ───────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s02: Tool Registry & Dispatch Map (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a task, or q to quit.\n"
      : `Model: ${MODEL}. Type a task, or q to quit.\n`
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];

  for (;;) {
    const query = await new Promise<string>((resolve) =>
      rl.question("\x1b[36ms02 >> \x1b[0m", resolve)
    );
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;
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
