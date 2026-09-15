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
 * cannot recurse. The harness also refuses `task` if a child still emits one.
 *
 * Each turn prints the raw `output` array, then the harness line. Offline
 * mode ignores the prompt and acts out: parent delegates → child cats
 * package.json in a 1-item context → only the summary re-enters the parent.
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
const MODEL_LABEL = OFFLINE ? "offline" : MODEL;

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
const PARENT_SCRIPT_RESULTS = 1; // one task result, then a final message

function runShell(command: string): string {
  const dangerous = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: dangerous command blocked";
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

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function padFor(who: Who): string {
  return who === "sub" ? "    " : "  ";
}

function toolsLabel(who: Who): string {
  return who === "sub" ? "shell" : "shell, task";
}

function threadStats(input: unknown[]): string {
  let users = 0;
  let calls = 0;
  let results = 0;
  let messages = 0;
  for (const item of input) {
    const row = item as { role?: string; type?: string };
    if (row.role === "user") users += 1;
    if (row.type === "function_call") calls += 1;
    if (row.type === "function_call_output") results += 1;
    if (row.type === "message") messages += 1;
  }
  return `${input.length} 条 · user ${users} · call ${calls} · result ${results} · message ${messages}`;
}

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

function printOutput(output: OutputItem[], pad: string): void {
  const json = JSON.stringify(
    output,
    (_key, value) =>
      typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…` : value,
    2,
  );
  console.log(dim(`${pad}output:`));
  for (const line of json.split("\n")) console.log(dim(`${pad}${line}`));
}

function previewToolOutput(result: string, pad: string, maxLines = 20): void {
  const all = result.split("\n");
  if (result === "(no output)" || result === "") {
    console.log(dim(`${pad}│ （成功，无 stdout）`));
    return;
  }
  const shown = all.slice(0, maxLines);
  for (const line of shown) console.log(dim(`${pad}│ ${line}`));
  const hidden = all.length - shown.length;
  if (hidden > 0) {
    console.log(dim(`${pad}│ … ${hidden} more lines（完整结果在当前线程里）`));
  }
}

function extractText(output: OutputItem[]): string {
  let text = "";
  for (const item of output) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && part.text) text += part.text;
    }
  }
  return text;
}

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
  type: "function_call",
  id,
  call_id: id,
  name: "shell",
  arguments: JSON.stringify({ command }),
});
const say = (text: string): OutputItem => ({
  type: "message",
  content: [{ type: "output_text", text }],
});
let subFreshSize = 0; // captured at spawn time to prove the child starts clean

function offlineModel(input: unknown[], who: Who): OutputItem[] {
  if (who === "sub") {
    const ran = countToolResults(input);
    if (ran === 0) return [shellCall("s1", "cat package.json")];
    return [
      say(
        `结论：本仓库是 ESM TypeScript 项目；运行时依赖 openai，开发依赖 tsx 与 typescript。` +
          `（子循环从 ${subFreshSize} 条消息起步，中间的 cat package.json 不会回到父线程。）`,
      ),
    ];
  }

  const ran = countToolResultsSinceLastUser(input);
  const alreadyPlayed = countToolResults(input) >= PARENT_SCRIPT_RESULTS && ran === 0;
  if (alreadyPlayed) {
    return [
      say(
        `[offline demo] 这条进程里的固定剧本已经演完（父委派 → 子查 package.json → 只回结论）。` +
          `刚才不是听懂了你的话。输入 q 退出；设 OPENAI_API_KEY 后工具才会跟着问题变。`,
      ),
    ];
  }
  if (ran === 0) {
    return [
      {
        type: "function_call",
        id: "t1",
        call_id: "t1",
        name: "task",
        arguments: JSON.stringify({
          description: "Inspect package.json and report the project's runtime and dev tooling.",
        }),
      },
    ];
  }
  return [
    say(
      `[offline demo] 子 Agent 只把结论文本带回来了。父线程只多了一次 task 调用和一条 result，` +
        `没有 cat package.json 的 stdout——那是子循环自己的历史，已经丢弃。` +
        `设 OPENAI_API_KEY 后，会不会委派才跟着你的问题变。`,
    ),
  ];
}

// ── The loop: returns the final text so a sub-agent can hand it back ────────
async function agentLoop(input: unknown[], who: Who): Promise<string> {
  const pad = padFor(who);
  if (who === "parent") {
    const lastUser = [...input].reverse().find((i) => (i as { role?: string }).role === "user") as
      | { content?: unknown }
      | undefined;
    if (typeof lastUser?.content === "string") console.log(dim(`  user: ${lastUser.content}`));
    if (OFFLINE) {
      const replay = countToolResults(input) >= PARENT_SCRIPT_RESULTS;
      console.log(
        dim(
          replay
            ? "[offline] 剧本已演过，不再重复派生子 Agent。"
            : "[offline] 不读你刚打的字。固定演示：父委派 → 子用 1 条消息查 package.json → 只把结论写回父线程。",
        ),
      );
    }
  }

  let turn = 0;
  for (;;) {
    turn += 1;
    const output = await callModel(input, who);
    input.push(...output);

    const calls = output.filter((i) => i.type === "function_call");
    const whoLabel = who === "sub" ? "sub" : "parent";
    console.log(cyan(`${pad}── ${whoLabel} turn ${turn} ──`));
    console.log(dim(`${pad}模型: ${MODEL_LABEL}`));
    console.log(dim(`${pad}角色: ${whoLabel}  工具: ${toolsLabel(who)}  线程: ${threadStats(input)}`));
    printOutput(output, pad);

    if (calls.length === 0) {
      const text = extractText(output);
      if (text) console.log(`${pad}message: ${text}`);
      if (who === "sub") {
        console.log(
          dim(`${pad}子循环结束。中间过程留在这份 input 里，函数返回后整份数组被丢弃；只把结论文本带回父线程。`),
        );
      }
      return text;
    }

    for (const call of calls) {
      const args = JSON.parse(call.arguments ?? "{}") as Record<string, unknown>;
      console.log(dim(`${pad}harness:`));
      let result: string;
      if (call.name === "task") {
        const description = String(args.description ?? "");
        if (who === "sub") {
          console.log(red(`${pad}task  （子 Agent 没有这个工具，harness 拒绝再派生）`));
          result = "Error: sub-agents cannot spawn further sub-agents";
          previewToolOutput(result, pad);
        } else {
          console.log(yellow(`${pad}task  ${description}`));
          console.log(dim(`${pad}父线程此刻不增长；下面整段是子循环（全新 input，没有 task 工具）`));
          result = await spawnSubagent(description);
          console.log(dim(`${pad}父线程收到的不是子循环的 output 数组，只是下面这段结论文本：`));
          previewToolOutput(result, pad);
        }
      } else {
        console.log(yellow(`${pad}$ ${String(args.command ?? "")}`));
        result = runShell(String(args.command ?? ""));
        previewToolOutput(result, pad);
      }
      console.log(
        green(
          who === "sub"
            ? `${pad}已写回子线程 function_call_output → continue（这条不会进父线程）`
            : `${pad}已写回 function_call_output → continue`,
        ),
      );
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── NEW in s06: spawn a child loop with a FRESH input array ────────────────
async function spawnSubagent(description: string): Promise<string> {
  console.log();
  console.log(magenta("    ── subagent spawned ──"));
  console.log(dim(`    任务: ${description}`));
  const subInput: unknown[] = [{ role: "user", content: description }]; // clean context
  subFreshSize = subInput.length;
  console.log(dim(`    子线程: ${threadStats(subInput)}（干净上下文）  工具: ${toolsLabel("sub")}  模型: ${MODEL_LABEL}`));
  console.log(dim("    注意：子循环复用同一个 agentLoop / 同一个 MODEL，换的是 input 和工具表。"));
  try {
    const result = await agentLoop(subInput, "sub");
    console.log(magenta("    ── subagent done ──"));
    console.log(dim("    回传给父: 1 条结论文本（不是子线程的完整消息列表）"));
    console.log();
    return result;
  } catch (err) {
    const result = `Error: sub-agent failed: ${errorText(err)}`;
    console.log(red("    ── subagent failed ──"));
    console.log(dim("    子循环异常不会把父循环打崩；错误字符串会作为 function_call_output 写回父线程。"));
    previewToolOutput(result, "    ");
    console.log();
    return result;
  }
}

// ── Entry point: a minimal REPL ────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s06: Subagents (delegate to a fresh-context child)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a task, or q to quit."
      : `Model: ${MODEL}. Type a task, or q to quit.`,
  );
  console.log(
    dim(
      OFFLINE
        ? "output: 是返回值。task 派生干净上下文的子循环，只把结论文本写回父线程。没 key：不读提示词，固定演示父委派 → 子查 package.json → 只回结论。\n"
        : "output: 是返回值。task 派生干净上下文的子循环，只把结论文本写回父线程。\n",
    ),
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];
  for (;;) {
    const query = await new Promise<string>((resolve) => rl.question("\x1b[36ms06 >> \x1b[0m", resolve));
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;
    thread.push({ role: "user", content: query });
    console.log();
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
