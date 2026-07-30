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
    description: "Apply a Codex-style patch to add, update or delete files.",
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

// A minimal Codex-style apply_patch: supports Add / Update / Delete File hunks.
function runApplyPatch(patch: string): string {
  const lines = patch.split("\n");
  const isMark = (s: string): boolean => s.startsWith("*** ");
  const done: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("*** Add File: ")) {
      const file = line.slice("*** Add File: ".length).trim();
      const body: string[] = [];
      for (i++; i < lines.length && !isMark(lines[i]); i++) {
        if (lines[i].startsWith("+")) body.push(lines[i].slice(1));
      }
      runWriteFile(file, body.join("\n") + "\n");
      done.push(`added ${file}`);
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const file = line.slice("*** Delete File: ".length).trim();
      fs.rmSync(resolvePath(file));
      done.push(`deleted ${file}`);
      i++;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const file = line.slice("*** Update File: ".length).trim();
      const oldLines: string[] = [];
      const newLines: string[] = [];
      for (i++; i < lines.length && !isMark(lines[i]); i++) {
        if (lines[i].startsWith("-")) oldLines.push(lines[i].slice(1));
        else if (lines[i].startsWith("+")) newLines.push(lines[i].slice(1));
      }
      const text = fs.readFileSync(resolvePath(file), "utf8");
      const oldBlock = oldLines.join("\n");
      if (!text.includes(oldBlock)) return `Error: context not found in ${file}`;
      fs.writeFileSync(resolvePath(file), text.replace(oldBlock, newLines.join("\n")));
      done.push(`updated ${file}`);
      continue;
    }
    i++;
  }
  return done.length ? `Patch applied: ${done.join(", ")}` : "Error: empty patch";
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

// Offline scripted model: it fans out THREE tool calls in a single turn, twice,
// so you can watch the dispatch map route each call by name.
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
      call("c4", "apply_patch", {
        patch:
          "*** Begin Patch\n*** Update File: agent_scratch/alpha.md\n@@\n" +
          "-# Alpha\n+# Alpha (patched)\n*** End Patch",
      }),
      call("c5", "read_file", { path: "agent_scratch/beta.md" }),
      call("c6", "list_dir", { path: "agent_scratch" }),
    ];
  }
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text:
            `[offline demo] One turn produced 3 tool calls at once, twice — the dispatch ` +
            `map routed each by name (write_file/shell, then apply_patch/read_file/list_dir). ` +
            `Set OPENAI_API_KEY for a real model; the loop and dispatch stay the same.`,
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
