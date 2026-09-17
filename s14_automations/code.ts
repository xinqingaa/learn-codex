#!/usr/bin/env tsx
/**
 * s14_automations/code.ts — Scheduled Runs (Codex App-style, TS)
 *
 * The CLI has no scheduler. Codex App automations live outside the loop:
 * a clock matcher enqueues due work; a dispatcher runs the same s01 loop.
 * Two kinds, matching ~/.codex/automations/<id>/automation.toml:
 *
 *   kind=cron       fresh turn (like `codex exec`) → findings go to an inbox
 *   kind=heartbeat  append the prompt to an existing thread and continue it
 *
 *      ┌────────────┐  due now   ┌─────────┐  agent idle  ┌──────────────┐
 *      │ SCHEDULER  │ ─────────► │  QUEUE  │ ───────────► │ DISPATCHER   │
 *      └────────────┘            └─────────┘              │ cron → new   │
 *           ▲ simulated minute                            │ heartbeat →  │
 *                                                         │ same thread  │
 *                                                         └──────────────┘
 *
 * Run it (self-running narrated demo):
 *     npx tsx s14_automations/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s14_automations/code.ts
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const openai = OFFLINE ? null : new OpenAI();
const CWD = process.cwd();
const TICK_MS = 240;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
function say(actor: string, msg: string): void {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  console.log(`\x1b[2m${t}s\x1b[0m \x1b[36m${actor.padEnd(10)}\x1b[0m ${msg}`);
}

// Teaching stand-in for RFC 5545 RRULE (5 fields: minute hour DOM month DOW).
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
  if (!(cronFieldMatches(minute, t.minute) && cronFieldMatches(hour, t.hour) && cronFieldMatches(month, t.month)))
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

// ── NEW in s14: App-style automations (cron = new turn, heartbeat = same thread)
type Kind = "cron" | "heartbeat";
type Automation = {
  id: string;
  kind: Kind;
  cron: string; // teaching stand-in for rrule
  prompt: string;
  recurring: boolean;
  lastRunAt?: string;
};
type InboxItem = { id: string; at: string; text: string };

const firedQueue: Automation[] = [];
const inbox: InboxItem[] = [];
const heartbeatThread: unknown[] = [
  { role: "user", content: "Watch this repo. Heartbeats will ask you to check in." },
];

class Scheduler {
  private automations = new Map<string, Automation>();
  register(a: Automation): void {
    this.automations.set(a.id, a);
    say("scheduler", `registered \x1b[35m${a.id}\x1b[0m kind=${a.kind} "${a.cron}"`);
  }
  tick(now: SimTime): void {
    const marker = `${now.hour}:${now.minute}@${now.dom}`;
    for (const a of [...this.automations.values()]) {
      if (!cronMatches(a.cron, now) || a.lastRunAt === marker) continue;
      a.lastRunAt = marker;
      firedQueue.push({ ...a });
      say("scheduler", `\x1b[33mfired\x1b[0m ${a.id} (${a.kind}) → queue=${firedQueue.length}`);
      if (!a.recurring) {
        this.automations.delete(a.id);
        say("scheduler", `one-shot ${a.id} deregistered`);
      }
    }
  }
}

const TOOLS = [
  {
    type: "function" as const, name: "shell",
    description: "Run a read-only shell command and return stdout+stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The command to run." } },
      required: ["command"], additionalProperties: false,
    },
    strict: true,
  },
];

function runShell(command: string): string {
  const blocked = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];
  if (blocked.some((d) => command.includes(d))) return "Error: dangerous command blocked";
  try {
    const out = execSync(command, { cwd: CWD, timeout: 30_000, maxBuffer: 1_048_576 });
    return (String(out).trim() || "(no output)").slice(0, 20_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

type OutputItem = {
  type: string; id?: string; call_id?: string; name?: string; arguments?: string;
  content?: { type: string; text?: string }[];
};

async function callModel(input: unknown[], job: Automation): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions:
        "You are an automated agent. Run one read-only shell command that satisfies the task, " +
        "then report the result in one line.",
      input: input as never, tools: TOOLS, reasoning: { effort: "low" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input, job);
}

function offlineModel(input: unknown[], job: Automation): OutputItem[] {
  let lastUser = -1;
  for (let i = 0; i < input.length; i++) if ((input[i] as { role?: string }).role === "user") lastUser = i;
  const ran = input.slice(lastUser + 1).filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (ran === 0) {
    const p = job.prompt.toLowerCase();
    const command = p.includes("test")
      ? "echo 'running tests…' && echo '42 passed, 0 failed'"
      : p.includes("lint") || p.includes("ci")
        ? "echo 'lint: no issues found'"
        : "git status --short 2>/dev/null || echo '(not a git repo)'";
    return [{
      type: "function_call", id: `call_${job.id}`, call_id: `call_${job.id}`,
      name: "shell", arguments: JSON.stringify({ command }),
    }];
  }
  const hit = [...input.slice(lastUser + 1)].reverse()
    .find((i) => (i as { type?: string }).type === "function_call_output") as { output?: string } | undefined;
  const line = String(hit?.output ?? "").split("\n")[0];
  return [{ type: "message", content: [{ type: "output_text", text: `[offline demo] ${job.id} done — ${line.slice(0, 60) || "ok"}` }] }];
}

async function runTurn(input: unknown[], job: Automation): Promise<string> {
  let last = "";
  for (let step = 0; step < 6; step++) {
    const output = await callModel(input, job);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        for (const c of item.content ?? [])
          if (c.type === "output_text" && c.text) {
            last = c.text;
            say("agent", `\x1b[32m${c.text}\x1b[0m`);
          }
      return last;
    }
    for (const call of calls) {
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      say("agent", `$ ${command}`);
      const result = runShell(command);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
  return last;
}

let halted = false;
async function dispatcher(): Promise<void> {
  while (!halted || firedQueue.length > 0) {
    const job = firedQueue.shift();
    if (!job) { await sleep(TICK_MS / 3); continue; }
    say("dispatcher", `idle → ${job.kind} ${job.id}`);
    if (job.kind === "heartbeat") {
      heartbeatThread.push({ role: "user", content: `[Heartbeat] ${job.prompt}` });
      await runTurn(heartbeatThread, job);
    } else {
      const fresh: unknown[] = [{ role: "user", content: `[Scheduled] ${job.prompt}` }];
      const text = await runTurn(fresh, job);
      inbox.push({ id: job.id, at: job.lastRunAt ?? "", text });
      say("inbox", `cron ${job.id} → Triage (${inbox.length} item(s))`);
    }
  }
}

async function main(): Promise<void> {
  console.log("s14: Scheduled Runs (Codex App-style)");
  console.log(
    OFFLINE
      ? "Offline demo. Scheduler fires cron (new turn + inbox) and heartbeat (same thread).\n"
      : `Model: ${MODEL}. Scheduler fires cron (new turn + inbox) and heartbeat (same thread).\n`
  );

  const scheduler = new Scheduler();
  scheduler.register({ id: "repo-check", kind: "cron", cron: "*/2 * * * *", prompt: "check the repo status", recurring: true });
  scheduler.register({ id: "watch", kind: "heartbeat", cron: "*/3 * * * *", prompt: "anything new to report?", recurring: true });
  scheduler.register({ id: "lint-once", kind: "cron", cron: "5 * * * *", prompt: "lint the codebase", recurring: false });

  const drain = dispatcher();
  for (let minute = 0; minute <= 5; minute++) {
    const now: SimTime = { minute, hour: 9, dom: 15, month: 7, dow: 3 };
    say("clock", `\x1b[2m— tick 09:0${minute} —\x1b[0m`);
    scheduler.tick(now);
    await sleep(TICK_MS);
  }
  halted = true;
  await drain;
  say("main", `inbox: ${inbox.map((i) => i.id).join(", ") || "(empty)"} · heartbeat turns=${heartbeatThread.length}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
