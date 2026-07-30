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
 * Run it:
 *     npm install
 *     npx tsx s05_plan_tool/code.ts          # offline demo model (no key needed)
 *     OPENAI_API_KEY=sk-... npx tsx s05_plan_tool/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

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
    const out = execSync(command, { cwd: CWD, timeout: 120_000, maxBuffer: 1024 * 1024 });
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
  return offlineModel();
}

// ── Offline demo: a scripted model that plans, then works the plan ─────────
// It shows update_plan being called before, during and after each step.
const planCall = (id: string, plan: PlanStep[]): OutputItem => ({
  type: "function_call", id, call_id: id, name: "update_plan",
  arguments: JSON.stringify({ plan }),
});
const shellCall = (id: string, command: string): OutputItem => ({
  type: "function_call", id, call_id: id, name: "shell",
  arguments: JSON.stringify({ command }),
});
const say = (text: string): OutputItem => ({
  type: "message", content: [{ type: "output_text", text }],
});

const SCRIPT: OutputItem[][] = [
  [planCall("p1", [
    { step: "Inspect the workspace", status: "in_progress" },
    { step: "Create hello.ts that prints a greeting", status: "pending" },
    { step: "Run it to verify the output", status: "pending" },
  ])],
  [shellCall("c1", "ls -la")],
  [planCall("p2", [
    { step: "Inspect the workspace", status: "completed" },
    { step: "Create hello.ts that prints a greeting", status: "in_progress" },
    { step: "Run it to verify the output", status: "pending" },
  ])],
  [shellCall("c2", "printf 'console.log(\"Hello, Codex!\");\\n' > hello.ts && echo 'wrote hello.ts'")],
  [planCall("p3", [
    { step: "Inspect the workspace", status: "completed" },
    { step: "Create hello.ts that prints a greeting", status: "completed" },
    { step: "Run it to verify the output", status: "in_progress" },
  ])],
  [shellCall("c3", "npx tsx hello.ts")],
  [planCall("p4", [
    { step: "Inspect the workspace", status: "completed" },
    { step: "Create hello.ts that prints a greeting", status: "completed" },
    { step: "Run it to verify the output", status: "completed" },
  ])],
  [say(
    `[offline demo] Planned 3 steps, then worked them in order, re-rendering ` +
    `the checklist as each one moved pending → in_progress → completed. The plan ` +
    `lived in the harness the whole time. Set OPENAI_API_KEY for a real model.`
  )],
];
let scriptIdx = 0;
function offlineModel(): OutputItem[] {
  const step = SCRIPT[Math.min(scriptIdx, SCRIPT.length - 1)];
  scriptIdx++;
  return step;
}

// ── The loop: identical to s01, plus a dispatch on the tool name ───────────
async function agentLoop(input: unknown[]): Promise<void> {
  for (;;) {
    const output = await callModel(input);
    input.push(...output);

    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        if (item.type === "message")
          for (const c of item.content ?? [])
            if (c.type === "output_text" && c.text) console.log(c.text);
      return;
    }

    for (const call of calls) {
      const args = JSON.parse(call.arguments ?? "{}") as Record<string, unknown>;
      let result: string;
      if (call.name === "update_plan") {
        result = updatePlan((args.plan as PlanStep[]) ?? []); // NEW in s05
      } else {
        console.log(`\x1b[33m$ ${args.command}\x1b[0m`);
        result = runShell(String(args.command ?? ""));
        console.log(result.split("\n").slice(0, 8).join("\n"));
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL ────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s05: The Plan Tool (update_plan)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a task, or q to quit.\n"
      : `Model: ${MODEL}. Type a task, or q to quit.\n`
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];
  for (;;) {
    const query = await new Promise<string>((resolve) => rl.question("\x1b[36ms05 >> \x1b[0m", resolve));
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
