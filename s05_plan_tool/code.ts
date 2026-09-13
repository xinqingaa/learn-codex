#!/usr/bin/env tsx
/**
 * s05_plan_tool/code.ts — The Plan Tool (`update_plan`)
 *
 * A long task drifts. The fix is not a smarter model — it is a *plan the
 * harness can see*. Codex gives the model an `update_plan` tool: the model
 * declares its steps up front, then rewrites the same list as it works. The
 * plan is not a thought in the model's head; it is a function_call whose
 * result the harness renders as a live checklist.
 *
 *     model                     harness
 *       |  update_plan(3 steps)   |
 *       | ----------------------> |  render checklist
 *       |  shell(step 1)          |
 *       | ----------------------> |  run it
 *       |  update_plan(1 done)    |
 *       | ----------------------> |  re-render: ✓ ▸ ·
 *       |        ...              |
 *
 * The tool does no real work — it cannot read a file or run a command. It
 * only lets the harness *watch the plan change*, which is what keeps a long
 * task from losing steps 4-10 to attention drift.
 *
 * Each turn prints the raw `output` array, then the harness line. Offline
 * mode ignores the prompt and writes .tmp/s05/hello.ts (same story as the
 * web simulator): update_plan → ls → rewrite plan → write hello.ts → run it.
 *
 * Run it:
 *     npm install
 *     npx tsx s05_plan_tool/code.ts          # offline demo model (no key needed)
 *     OPENAI_API_KEY=sk-... npx tsx s05_plan_tool/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const TMP_DIR = path.join(CWD, ".tmp", "s05");
const HELLO_REL = path.join(".tmp", "s05", "hello.ts");
const TMP_REL = path.join(".tmp", "s05");
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const MODEL_LABEL = OFFLINE ? "offline" : MODEL;

const INSTRUCTIONS =
  `You are a coding agent running in ${CWD}. ` +
  `For any multi-step task, FIRST call update_plan with the full step list, ` +
  `then work the steps one at a time, calling update_plan again whenever a ` +
  `step changes status. Exactly one step may be in_progress at a time.`;

// ── Tools: the s01 shell plus, NEW in s05, the plan tool ───────────────────
const TOOLS = [
  {
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
  },
  // ── NEW in s05: update_plan — declare and re-declare the step list ──────
  {
    type: "function" as const,
    name: "update_plan",
    description:
      "Replace the current plan with an ordered step list. Call it first with " +
      "all steps pending, then again each time a step starts or finishes.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "array",
          description: "The full plan. Send the whole list every time, not a diff.",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
    strict: true,
  },
];

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

// ── NEW in s05: the plan lives in the harness, not the model ───────────────
type PlanStep = { step: string; status: "pending" | "in_progress" | "completed" };
let currentPlan: PlanStep[] = [];

const ICON: Record<PlanStep["status"], string> = {
  pending: "\x1b[90m○\x1b[0m", // grey hollow
  in_progress: "\x1b[36m▸\x1b[0m", // cyan arrow
  completed: "\x1b[32m✓\x1b[0m", // green check
};

// The tool handler: store the plan and re-render the checklist. The string it
// returns is what the model sees back as a function_call_output.
function updatePlan(plan: PlanStep[]): string {
  currentPlan = plan;
  const done = plan.filter((s) => s.status === "completed").length;
  console.log(`\n\x1b[1m## Plan\x1b[0m  \x1b[90m(${done}/${plan.length} done)\x1b[0m`);
  for (const s of plan) console.log(`  ${ICON[s.status]} ${s.step}`);
  console.log();
  return `Plan updated: ${done}/${plan.length} steps completed.`;
}

// ── Model adapter (same shape as s01) ──────────────────────────────────────
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

const SCRIPT_TOOL_COUNT = 7; // 4 update_plan + 3 shell

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
    console.log(dim("  │ （成功，无 stdout）"));
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
      reasoning: { effort: "medium" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input);
}

// Scripted stand-in: same story as the web simulator.
// Ignores the user text. Plan → ls → rewrite plan → write hello.ts → run → all done.
const planCall = (id: string, plan: PlanStep[]): OutputItem => ({
  type: "function_call",
  id,
  call_id: id,
  name: "update_plan",
  arguments: JSON.stringify({ plan }),
});
const shellCall = (id: string, command: string): OutputItem => ({
  type: "function_call",
  id,
  call_id: id,
  name: "shell",
  arguments: JSON.stringify({ command }),
});

const STEP_INSPECT = "Inspect the workspace";
const STEP_WRITE = `Create ${HELLO_REL} that prints a greeting`;
const STEP_RUN = `Run it to verify the output`;

function scriptTurn(ran: number, turn: number): OutputItem[] | null {
  if (ran === 0) {
    return [
      planCall(`call_${turn}_p1`, [
        { step: STEP_INSPECT, status: "in_progress" },
        { step: STEP_WRITE, status: "pending" },
        { step: STEP_RUN, status: "pending" },
      ]),
    ];
  }
  if (ran === 1) return [shellCall(`call_${turn}_c1`, `ls -la ${TMP_REL}`)];
  if (ran === 2) {
    return [
      planCall(`call_${turn}_p2`, [
        { step: STEP_INSPECT, status: "completed" },
        { step: STEP_WRITE, status: "in_progress" },
        { step: STEP_RUN, status: "pending" },
      ]),
    ];
  }
  if (ran === 3) {
    return [
      shellCall(
        `call_${turn}_c2`,
        `printf 'console.log("Hello, Codex!");\\n' > ${HELLO_REL} && echo "wrote ${HELLO_REL}"`,
      ),
    ];
  }
  if (ran === 4) {
    return [
      planCall(`call_${turn}_p3`, [
        { step: STEP_INSPECT, status: "completed" },
        { step: STEP_WRITE, status: "completed" },
        { step: STEP_RUN, status: "in_progress" },
      ]),
    ];
  }
  if (ran === 5) return [shellCall(`call_${turn}_c3`, `npx tsx ${HELLO_REL}`)];
  if (ran === 6) {
    return [
      planCall(`call_${turn}_p4`, [
        { step: STEP_INSPECT, status: "completed" },
        { step: STEP_WRITE, status: "completed" },
        { step: STEP_RUN, status: "completed" },
      ]),
    ];
  }
  return null;
}

function offlineModel(input: unknown[]): OutputItem[] {
  const ran = countToolResultsSinceLastUser(input);
  const alreadyPlayed = countToolResults(input) >= SCRIPT_TOOL_COUNT && ran === 0;
  const turn = input.filter((i) => (i as { role?: string }).role === "user").length;

  if (alreadyPlayed) {
    return [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text:
              `[offline demo] 这条进程里的固定剧本已经演完（update_plan → 写 ${HELLO_REL} → 跑通）。` +
              `刚才不是听懂了你的话。输入 q 退出；设 OPENAI_API_KEY 后工具才会跟着问题变。`,
          },
        ],
      },
    ];
  }

  if (ran === 0) {
    currentPlan = [];
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  const next = scriptTurn(ran, turn);
  if (next) return next;

  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text:
            `[offline demo] 先 update_plan 列出 3 步，再逐步执行并重写同一份清单：pending → in_progress → completed。` +
            `计划活在 harness 里，不在模型脑子里。已写入并跑通 ${HELLO_REL}。` +
            `这是固定剧本，不是在回答你刚打的字。设 OPENAI_API_KEY 后，工具才会跟着问题变——循环不变，只是多了 update_plan 这条特殊分发。`,
        },
      ],
    },
  ];
}

// ── The loop: identical to s01, plus a dispatch on the tool name ───────────
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
          : `[offline] 不读你刚打的字。固定演示：update_plan 三步 → 写 ${HELLO_REL} → 跑通。`
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

    for (const call of calls) {
      const args = JSON.parse(call.arguments ?? "{}") as Record<string, unknown>;
      console.log(dim("  harness:"));
      let result: string;
      if (call.name === "update_plan") {
        const plan = (args.plan as PlanStep[]) ?? [];
        console.log(yellow(`  update_plan  (${plan.length} steps)`));
        result = updatePlan(plan); // NEW in s05: harness state, not the filesystem
        previewToolOutput(result);
      } else {
        console.log(yellow(`  $ ${String(args.command ?? "")}`));
        result = runShell(String(args.command ?? ""));
        previewToolOutput(result);
      }
      console.log(green("  已写回 function_call_output → continue"));
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL ────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s05: The Plan Tool (update_plan)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a task, or q to quit."
      : `Model: ${MODEL}. Type a task, or q to quit.`
  );
  console.log(
    dim(
      OFFLINE
        ? "output: 是返回值。update_plan 只改 harness 里的清单，shell 才写文件。没 key：不读提示词，固定演示写入 .tmp/s05/hello.ts。\n"
        : "output: 是返回值。update_plan 只改 harness 里的清单，shell 才写文件。\n"
    )
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];
  for (;;) {
    const query = await new Promise<string>((resolve) => rl.question("\x1b[36ms05 >> \x1b[0m", resolve));
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
