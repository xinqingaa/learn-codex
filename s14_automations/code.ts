#!/usr/bin/env tsx
/**
 * s14_automations/code.ts — Scheduled Runs (Codex-style, in TypeScript)
 *
 * Everything so far was reactive: you type a task, the agent runs one turn. An
 * AUTOMATION flips that — the harness itself decides *when* to run. A scheduler
 * matches the current time against a cron expression, enqueues the triggered
 * task, and a dispatcher (only when the agent is idle) pops it and runs the
 * ordinary agent loop on it. Trigger and execution are decoupled by a queue:
 *
 *      ┌────────────┐  cron match   ┌─────────┐  agent idle  ┌──────────────┐
 *      │ SCHEDULER  │ ────────────► │  QUEUE  │ ───────────► │ DISPATCHER   │
 *      │ (per tick) │               │ (fired) │              │ runs agent   │
 *      └────────────┘               └─────────┘              │ loop on task │
 *           ▲ simulated clock ticks one minute               └──────────────┘
 *
 * This mirrors Codex automations: a scheduled task fires on a cadence and runs
 * a full agent turn against the repo, with no human prompting each time.
 *
 * Run it (self-running narrated demo):
 *     npm install
 *     npx tsx s14_automations/code.ts                       # offline demo
 *     OPENAI_API_KEY=sk-... npx tsx s14_automations/code.ts # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const openai = OFFLINE ? null : new OpenAI();
const CWD = process.cwd();

const TICK_MS = 240; // one simulated minute per tick, so the demo stays fast
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
function say(actor: string, msg: string): void {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  console.log(`\x1b[2m${t}s\x1b[0m \x1b[36m${actor.padEnd(10)}\x1b[0m ${msg}`);
}

// ── A tiny cron matcher (5 fields: minute hour day-of-month month day-of-week) ─
// Supports `*`, `*/N`, `N`, `N-M`, and comma lists. Standard cron semantics:
// minute/hour/month must ALL match; when day-of-month and day-of-week are both
// constrained, EITHER matching is enough (OR).
function cronFieldMatches(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    if (part === "*") return true;
    const step = /^(\*)\/(\d+)$/.exec(part);
    if (step && value % Number(step[2]) === 0) return true;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range && value >= Number(range[1]) && value <= Number(range[2])) return true;
    if (/^\d+$/.test(part) && value === Number(part)) return true;
  }
  return false;
}

type SimTime = { minute: number; hour: number; dom: number; month: number; dow: number };

function cronMatches(expr: string, t: SimTime): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [minute, hour, dom, month, dow] = f;
  if (
    !(
      cronFieldMatches(minute, t.minute) &&
      cronFieldMatches(hour, t.hour) &&
      cronFieldMatches(month, t.month)
    )
  )
    return false;
  const domAny = dom === "*";
  const dowAny = dow === "*";
  if (domAny && dowAny) return true;
  const domOk = cronFieldMatches(dom, t.dom);
  const dowOk = cronFieldMatches(dow, t.dow);
  if (domAny) return dowOk;
  if (dowAny) return domOk;
  return domOk || dowOk;
}

// ── NEW in s14: the automation registry + scheduler ──────────────────────────
type Automation = {
  id: string;
  cron: string; // "*/2 * * * *"
  prompt: string; // injected as a user turn when it fires
  recurring: boolean; // false = one-shot, deregister after firing
  lastFired?: string; // "HH:MM@dom" marker, prevents a double-fire in one minute
};

// The queue that decouples the producer (scheduler) from the consumer (agent).
const firedQueue: Automation[] = [];

class Scheduler {
  private automations = new Map<string, Automation>();
  register(a: Automation): void {
    this.automations.set(a.id, a);
    say("scheduler", `registered \x1b[35m${a.id}\x1b[0m "${a.cron}" — ${a.prompt}`);
  }
  // Advance the simulated clock one minute; enqueue every automation that fires.
  tick(now: SimTime): void {
    const marker = `${now.hour}:${now.minute}@${now.dom}`;
    for (const a of [...this.automations.values()]) {
      if (!cronMatches(a.cron, now) || a.lastFired === marker) continue;
      a.lastFired = marker;
      firedQueue.push(a); // producer side: just enqueue, never run
      say("scheduler", `\x1b[33mfired\x1b[0m ${a.id} → enqueued (queue=${firedQueue.length})`);
      if (!a.recurring) {
        this.automations.delete(a.id);
        say("scheduler", `one-shot ${a.id} deregistered`);
      }
    }
  }
}

// ── The agent's one tool (from s01/s02): a guarded shell ─────────────────────
const TOOLS = [
  {
    type: "function" as const,
    name: "shell",
    description: "Run a read-only shell command and return stdout+stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function runShell(command: string): string {
  const blocked = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];
  if (blocked.some((d) => command.includes(d))) return "Error: dangerous command blocked";
  try {
    const out = execSync(command, { cwd: CWD, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return (String(out).trim() || "(no output)").slice(0, 20_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

// ── Model adapter (same shape as s01) ────────────────────────────────────────
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

async function callModel(input: unknown[], job: Automation): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions:
        "You are an automated agent fired by a schedule. Run one read-only shell " +
        "command that satisfies the task, then report the result in one line.",
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "low" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input, job);
}

// Scripted stand-in: pick a read-only command from the task, run it, report.
function offlineModel(input: unknown[], job: Automation): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (ran === 0) {
    const p = job.prompt.toLowerCase();
    const command = p.includes("test")
      ? "echo 'running tests…' && echo '42 passed, 0 failed'"
      : p.includes("lint") || p.includes("ci")
        ? "echo 'lint: no issues found'"
        : "git status --short 2>/dev/null || echo '(not a git repo)'";
    return [
      {
        type: "function_call",
        id: `call_${job.id}`,
        call_id: `call_${job.id}`,
        name: "shell",
        arguments: JSON.stringify({ command }),
      },
    ];
  }
  const out = String(
    (input.find((i) => (i as { type?: string }).type === "function_call_output") as {
      output?: string;
    })?.output ?? ""
  ).split("\n")[0];
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: `[offline demo] ${job.id} done — ${out.slice(0, 60) || "ok"}`,
        },
      ],
    },
  ];
}

// ── The core loop (unchanged since s01): run ONE fired task to completion ────
async function runAutomation(job: Automation): Promise<void> {
  const input: unknown[] = [{ role: "user", content: `[Scheduled] ${job.prompt}` }];
  for (let step = 0; step < 6; step++) {
    const output = await callModel(input, job);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        for (const c of item.content ?? [])
          if (c.type === "output_text" && c.text) say("agent", `\x1b[32m${c.text}\x1b[0m`);
      return;
    }
    for (const call of calls) {
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      say("agent", `$ ${command}`);
      const result = runShell(command);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── NEW in s14: the dispatcher — consumer side, runs only when the agent is idle ─
let halted = false;
async function dispatcher(): Promise<void> {
  while (!halted || firedQueue.length > 0) {
    const job = firedQueue.shift(); // consumer side: pop when free
    if (!job) {
      await sleep(TICK_MS / 3);
      continue;
    }
    say("dispatcher", `agent idle → dequeue ${job.id}, running a full turn`);
    await runAutomation(job);
  }
}

// ── Self-running narrated demo ────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s14: Scheduled Runs (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). A scheduler fires tasks; the agent runs them.\n"
      : `Model: ${MODEL}. A scheduler fires tasks; the agent runs them.\n`
  );

  const scheduler = new Scheduler();
  scheduler.register({ id: "repo-check", cron: "*/2 * * * *", prompt: "check the repo status", recurring: true });
  scheduler.register({ id: "nightly-test", cron: "*/3 * * * *", prompt: "run the test suite", recurring: true });
  scheduler.register({ id: "lint-once", cron: "5 * * * *", prompt: "lint the codebase", recurring: false });

  const drain = dispatcher(); // consumer runs alongside the producer
  // Producer: tick a simulated clock from minute 0 to 5 (one "minute" per tick).
  for (let minute = 0; minute <= 5; minute++) {
    const now: SimTime = { minute, hour: 9, dom: 15, month: 7, dow: 3 };
    say("clock", `\x1b[2m— tick 09:0${minute} —\x1b[0m`);
    scheduler.tick(now);
    await sleep(TICK_MS);
  }
  halted = true;
  await drain; // let the queue empty before exiting

  say("main", "all fired tasks drained — scheduler and dispatcher decoupled by the queue");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
