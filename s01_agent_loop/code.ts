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
 * Each turn prints the raw `output` array, then the harness `$` line if it
 * ran a tool. Offline mode ignores the prompt and writes .tmp/s01/hello.ts
 * (same story as the web simulator).
 *
 * Run it:
 *     npm install
 *     npx tsx s01_agent_loop/code.ts          # offline demo model (no key needed)
 *     OPENAI_API_KEY=sk-... npx tsx s01_agent_loop/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const TMP_DIR = path.join(CWD, ".tmp", "s01");
const HELLO_ABS = path.join(TMP_DIR, "hello.ts");
const HELLO_REL = path.relative(CWD, HELLO_ABS) || path.join(".tmp", "s01", "hello.ts");

// No API key (or CODEX_OFFLINE=1)? Fall back to a scripted offline model so
// you can watch the loop work without spending tokens. Set a key for the real thing.
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const MODEL_LABEL = OFFLINE ? "offline" : MODEL;

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

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

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

// Scripted stand-in: same story as the web simulator (write hello.ts → cat → stop).
// Ignores the user text. Plays once per process; later prompts do not re-run shell.
function offlineModel(input: unknown[]): OutputItem[] {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const ran = countToolResultsSinceLastUser(input);
  const alreadyPlayed = countToolResults(input) >= 2 && ran === 0;
  const turn = input.filter((i) => (i as { role?: string }).role === "user").length;
  const hello = JSON.stringify(HELLO_REL);

  const call = (id: string, command: string): OutputItem => ({
    type: "function_call",
    id,
    call_id: id,
    name: "shell",
    arguments: JSON.stringify({ command }),
  });

  if (alreadyPlayed) {
    return [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text:
              `[offline demo] 这条进程里的固定剧本已经演完（写 hello.ts → cat）。` +
              `刚才不是听懂了你的话。输入 q 退出；设 OPENAI_API_KEY 后命令才会跟着问题变。`,
          },
        ],
      },
    ];
  }

  if (ran === 0) {
    return [call(`call_${turn}_1`, `echo 'console.log("Hello, Codex!")' > ${hello}`)];
  }
  if (ran === 1) return [call(`call_${turn}_2`, `cat ${hello}`)];

  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text:
            `[offline demo] 已写入 ${HELLO_REL} 并核对。这是固定剧本，不是在回答你刚打的字。` +
            `设 OPENAI_API_KEY 后，命令才会跟着问题变——循环本身不变。`,
        },
      ],
    },
  ];
}

// ── The core pattern: keep calling tools until the model stops ─────────────
async function agentLoop(input: unknown[]): Promise<void> {
  const lastUser = [...input].reverse().find((i) => (i as { role?: string }).role === "user") as
    | { content?: unknown }
    | undefined;
  if (typeof lastUser?.content === "string") console.log(dim(`  user: ${lastUser.content}`));
  if (OFFLINE) {
    const replay = countToolResults(input) >= 2;
    console.log(
      dim(
        replay
          ? "[offline] 剧本已演过，不再重复执行命令。"
          : "[offline] 不读你刚打的字。固定演示：创建 hello.ts → 核对 → 收尾。"
      )
    );
  }
  let turn = 0;
  for (;;) {
    turn += 1;
    const output = await callModel(input);
    // Append the whole turn (reasoning + message + calls) to the thread.
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

    for (const call of calls) {
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      console.log(dim("  harness 执行:"));
      console.log(yellow(`  $ ${command}`));
      const result = runShell(command);
      previewToolOutput(result);
      console.log(green("  已写回 function_call_output → continue"));
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL ─────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s01: The Agent Loop (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a task, or q to quit."
      : `Model: ${MODEL}. Type a task, or q to quit.`
  );
  console.log(
    dim(
      OFFLINE
        ? "output: 是返回值。$ 是 harness 跑的命令。没 key：不读提示词，固定演示创建 .tmp/s01/hello.ts。\n"
        : "output: 是返回值。$ 是 harness 跑的命令。\n"
    )
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];

  for (;;) {
    const query = await new Promise<string>((resolve) =>
      rl.question("\x1b[36ms01 >> \x1b[0m", resolve)
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
