#!/usr/bin/env tsx
/**
 * s06_subagents/code.ts — Subagents: delegate to a child with a fresh context
 *
 * Tracing a call chain pollutes the main thread: thirty file reads later, the
 * model has forgotten the bug it was fixing. A human opens a *new terminal*
 * for the digression, then closes it and keeps the notes. A subagent is that
 * new terminal: a child agent loop with its OWN clean input array.
 *
 *     parent loop                          child loop
 *       |  task("research X")                |
 *       | ------------------> spawn --------> |  input = [ task ]   (fresh!)
 *       |                                     |  run its own loop
 *       |  <---------- only the summary ----- |  return final text
 *       |  result fed back as a tool output   |
 *
 * The child's intermediate turns are discarded; only its conclusion returns to
 * the parent as a function_call_output. The child gets no `task` tool, so it
 * cannot recurse.
 *
 * Run it:
 *     npm install
 *     npx tsx s06_subagents/code.ts          # offline demo model (no key needed)
 *     OPENAI_API_KEY=sk-... npx tsx s06_subagents/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

const INSTRUCTIONS =
  `You are a coding agent running in ${CWD}. ` +
  `If a subtask would take several lookups and clutter this thread, delegate it ` +
  `with the task tool and use only the conclusion it returns. Do simple things yourself.`;

const SUB_INSTRUCTIONS =
  `You are a sub-agent with a fresh context. Complete the one task you were ` +
  `given, then return a concise summary. You cannot delegate further.`;

// ── Tools ───────────────────────────────────────────────────────────────────
const SHELL_TOOL = {
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
};

// ── NEW in s06: the task tool — only the parent has it ─────────────────────
const TASK_TOOL = {
  type: "function" as const,
  name: "task",
  description:
    "Delegate a self-contained subtask to a sub-agent that runs with a fresh " +
    "context and returns only its final conclusion.",
  parameters: {
    type: "object",
    properties: { description: { type: "string", description: "What the sub-agent should do." } },
    required: ["description"],
    additionalProperties: false,
  },
  strict: true,
};

const TOOLS = [SHELL_TOOL, TASK_TOOL]; // parent
const SUB_TOOLS = [SHELL_TOOL]; // child: no task tool → no recursion

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

// ── Model adapter ───────────────────────────────────────────────────────────
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};
type Who = "parent" | "sub";

const openai = OFFLINE ? null : new OpenAI();

async function callModel(input: unknown[], who: Who): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions: who === "sub" ? SUB_INSTRUCTIONS : INSTRUCTIONS,
      input: input as never,
      tools: who === "sub" ? SUB_TOOLS : TOOLS,
      reasoning: { effort: "medium" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input, who);
}

// ── Offline demo: a parent that delegates, and a child that reports ─────────
const shellCall = (id: string, command: string): OutputItem => ({
  type: "function_call", id, call_id: id, name: "shell",
  arguments: JSON.stringify({ command }),
});
const say = (text: string): OutputItem => ({
  type: "message", content: [{ type: "output_text", text }],
});
const lastOutput = (input: unknown[]): string =>
  String(
    (input.filter((i) => (i as { type?: string }).type === "function_call_output").pop() as {
      output?: string;
    })?.output ?? ""
  );

let parentStep = 0;
let subFreshSize = 0; // captured at spawn time to prove the child starts clean

function offlineModel(input: unknown[], who: Who): OutputItem[] {
  if (who === "sub") {
    const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
    if (ran === 0) return [shellCall("s1", "cat package.json")];
    return [say(
      `[sub] Fresh ${subFreshSize}-item context, ran one lookup, returning only this summary: ` +
      `the repo is an ESM TypeScript project — runtime dep "openai", dev deps "tsx" + "typescript".`
    )];
  }
  // parent
  if (parentStep === 0) {
    parentStep++;
    return [{
      type: "function_call", id: "t1", call_id: "t1", name: "task",
      arguments: JSON.stringify({
        description: "Inspect package.json and report the project's runtime and dev tooling.",
      }),
    }];
  }
  return [say(
    `[offline demo] The sub-agent reported: "${lastOutput(input)}" — I handed the digging to a ` +
    `child with its own clean context and only its conclusion came back into my thread. ` +
    `Set OPENAI_API_KEY for a real model.`
  )];
}

// ── The loop: returns the final text so a sub-agent can hand it back ────────
async function agentLoop(input: unknown[], who: Who): Promise<string> {
  const pad = who === "sub" ? "  \x1b[90m[sub]\x1b[0m " : "";
  for (;;) {
    const output = await callModel(input, who);
    input.push(...output);

    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      let text = "";
      for (const item of output)
        if (item.type === "message")
          for (const c of item.content ?? [])
            if (c.type === "output_text" && c.text) text += c.text;
      console.log(pad + text);
      return text;
    }

    for (const call of calls) {
      const args = JSON.parse(call.arguments ?? "{}") as Record<string, unknown>;
      let result: string;
      if (call.name === "task") {
        result = await spawnSubagent(String(args.description ?? "")); // NEW in s06
      } else {
        console.log(`${pad}\x1b[33m$ ${args.command}\x1b[0m`);
        result = runShell(String(args.command ?? ""));
        console.log(pad + result.split("\n").slice(0, 6).join("\n" + pad));
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── NEW in s06: spawn a child loop with a FRESH input array ────────────────
async function spawnSubagent(description: string): Promise<string> {
  console.log(`\n\x1b[35m[subagent spawned]\x1b[0m ${description}`);
  const subInput: unknown[] = [{ role: "user", content: description }]; // clean context
  subFreshSize = subInput.length;
  const result = await agentLoop(subInput, "sub"); // its own loop, its own tools
  console.log("\x1b[35m[subagent done]\x1b[0m");
  return result; // only the conclusion returns; the child's turns are dropped
}

// ── Entry point: a minimal REPL ────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s06: Subagents (delegate to a fresh-context child)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a task, or q to quit.\n"
      : `Model: ${MODEL}. Type a task, or q to quit.\n`
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];
  for (;;) {
    const query = await new Promise<string>((resolve) => rl.question("\x1b[36ms06 >> \x1b[0m", resolve));
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;
    thread.push({ role: "user", content: query });
    try {
      await agentLoop(thread, "parent");
    } catch (err) {
      console.error("agent error:", err);
    }
    console.log();
  }
  rl.close();
}

main();
