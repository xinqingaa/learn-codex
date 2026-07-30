#!/usr/bin/env tsx
/**
 * s01_agent_loop/code.ts — The Agent Loop (Codex-style, in TypeScript)
 *
 * The entire secret of a coding agent in one pattern:
 *
 *     while the model keeps calling tools:
 *         response = model(input, tools)
 *         execute the tool calls
 *         append the outputs
 *
 *     +----------+      +---------+      +----------+
 *     |   User   | ---> |  Model  | ---> |   Tool   |
 *     |  prompt  |      | (loop)  |      |  shell   |
 *     +----------+      +----+----+      +----+-----+
 *                            ^                |
 *                            |  tool output   |
 *                            +----------------+
 *                         (loop continues)
 *
 * This mirrors how Codex drives the OpenAI Responses API: the model returns
 * a list of output items (reasoning / message / function_call); the harness
 * executes every function_call and feeds each result back as a
 * function_call_output item, until the model stops calling tools.
 *
 * Run it:
 *     npm install
 *     npx tsx s01_agent_loop/code.ts          # offline demo model (no key needed)
 *     OPENAI_API_KEY=sk-... npx tsx s01_agent_loop/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();

// No API key (or CODEX_OFFLINE=1)? Fall back to a scripted offline model so
// you can watch the loop work without spending tokens. Set a key for the real thing.
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

// The harness-level instructions. Codex assembles these from AGENTS.md,
// config.toml and built-ins (chapter s10); here we hardcode one string.
const INSTRUCTIONS =
  `You are a coding agent running in ${CWD}. ` +
  `Use the shell tool to solve the task. Act, don't explain.`;

// ── The one and only tool this chapter has: a shell ────────────────────────
// Responses API function tool. Later chapters register more tools into a map.
const TOOLS = [
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

// ── Tool execution ──────────────────────────────────────────────────────────
function runShell(command: string): string {
  // A teaching guardrail only. Chapter s03/s04 build the real approval +
  // sandbox system; never rely on a string match for safety in production.
  const dangerous = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: dangerous command blocked";
  }
  try {
    const out = execSync(command, {
      cwd: CWD,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const text = String(out).trim();
    return (text || "(no output)").slice(0, 50_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

// ── Model adapter ───────────────────────────────────────────────────────────
// Both branches return the same thing: a list of Responses API output items.
// The loop below therefore never changes — only the model behind it does.
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
      reasoning: { effort: "medium" }, // Codex runs on reasoning models
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input);
}

// A tiny scripted stand-in for the model. It decides to run a couple of shell
// commands, reads the outputs, then answers — enough to exercise the loop.
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = input.filter(
    (i) => (i as { type?: string }).type === "function_call_output"
  ).length;

  const call = (id: string, command: string): OutputItem => ({
    type: "function_call",
    id,
    call_id: id,
    name: "shell",
    arguments: JSON.stringify({ command }),
  });

  if (ran === 0) return [call("call_1", "ls -la")];
  if (ran === 1) return [call("call_2", "git branch --show-current 2>/dev/null || echo '(not a git repo)'")];

  const listing = String(
    (input.find((i) => (i as { type?: string }).type === "function_call_output") as {
      output?: string;
    })?.output ?? ""
  ).split("\n").length;
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text:
            `[offline demo] I ran the shell tool twice and read the results. ` +
            `The directory listing had ~${listing} lines. Set OPENAI_API_KEY to run ` +
            `against a real model — the loop above stays exactly the same.`,
        },
      ],
    },
  ];
}

// ── The core pattern: keep calling tools until the model stops ─────────────
async function agentLoop(input: unknown[]): Promise<void> {
  for (;;) {
    const output = await callModel(input);
    // Append the whole turn (reasoning + message + calls) to the thread.
    input.push(...output);

    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      // The model is done: print its final text.
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
      console.log(result.split("\n").slice(0, 8).join("\n"));
      // Feed the result back so the model can keep reasoning.
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL ─────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s01: The Agent Loop (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a task, or q to quit.\n"
      : `Model: ${MODEL}. Type a task, or q to quit.\n`
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];

  for (;;) {
    const query = await new Promise<string>((resolve) =>
      rl.question("\x1b[36ms01 >> \x1b[0m", resolve)
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
