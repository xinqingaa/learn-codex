#!/usr/bin/env tsx
/**
 * s17_autonomous_agents/code.ts — Self-Claiming Workers (Codex-style, in TypeScript)
 *
 * s16 gave us named teammates that wait for a lead to hand them work. That does
 * not scale: with 10 pending tasks the lead would assign 10 times. This chapter
 * removes the lead from the loop — an idle worker POLLS the shared task board,
 * atomically CLAIMS a pending task, runs it in its own context, and posts the
 * result back:
 *
 *      ┌───────────┐  scan            ┌───────────────────────────┐
 *      │ worker A  │ ───────────────► │                           │
 *      │  (idle)   │ ◄─────────────── │      SHARED TASK BOARD    │
 *      └─────┬─────┘  claim: WON      │  pending → in_progress    │
 *            │                        │          → done           │
 *      ┌─────┴─────┐                  │  (claim is atomic: the    │
 *      │ worker B  │ ───────────────► │   critical section has    │
 *      │  (idle)   │ ◄─────────────── │   exactly one winner)     │
 *      └───────────┘  claim: LOST     └───────────────────────────┘
 *
 * The race is the whole point: two workers can SCAN the same task in the same
 * instant, so the authoritative "is it still free?" check must happen INSIDE
 * the claim's critical section. The loser re-scans and takes the next task.
 * No lead, no double-claim — workers self-organize.
 *
 * Run it (self-running narrated demo):
 *     npm install
 *     npx tsx s17_autonomous_agents/code.ts                       # offline demo
 *     OPENAI_API_KEY=sk-... npx tsx s17_autonomous_agents/code.ts # real model
 */

import OpenAI from "openai";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const openai = OFFLINE ? null : new OpenAI();

const POLL_MS = 120; // how often an idle worker re-scans the board
const CLAIM_LATENCY_MS = 40; // models slow board storage — widens the race window
const WORK_MS = 150; // a real task takes time; simulated so parallel work is visible

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
function say(actor: string, msg: string): void {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  console.log(`\x1b[2m${t}s\x1b[0m \x1b[36m${actor.padEnd(6)}\x1b[0m ${msg}`);
}

// ── The shared task board (from s12) ─────────────────────────────────────────
type TaskStatus = "pending" | "in_progress" | "done";
type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  owner?: string;
  result?: string;
  blockedBy: string[];
};

// A promise-chain mutex: the critical section that makes a claim atomic. The
// real Codex board is file-backed and serializes with a lockfile; here a mutex
// plays the same role for the in-memory board.
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

class TaskBoard {
  private tasks = new Map<string, Task>();
  private lock = new Mutex();

  add(task: Task): void {
    this.tasks.set(task.id, task);
  }
  all(): Task[] {
    return [...this.tasks.values()];
  }
  private claimable(t: Task): boolean {
    return (
      t.status === "pending" &&
      !t.owner &&
      t.blockedBy.every((id) => this.tasks.get(id)?.status === "done")
    );
  }
  // Pure read — NO lock. Two workers may read the same head task here.
  scan(): Task | undefined {
    return this.all().find((t) => this.claimable(t));
  }
  allSettled(): boolean {
    return this.all().every((t) => t.status === "done");
  }
  anyBusy(): boolean {
    return this.all().some((t) => t.status === "in_progress");
  }

  // ── NEW in s17: the atomic claim ──────────────────────────────────────────
  // The scan result is already stale by the time we get here. We model slow
  // storage with a sleep (the race window), then re-check ownership INSIDE the
  // mutex. Only the worker that finds the task still free wins; everyone else
  // gets a honest "lost" and re-scans. This is what stops a double-claim.
  async claim(id: string, owner: string): Promise<{ ok: boolean; reason: string }> {
    await sleep(CLAIM_LATENCY_MS); // read-then-write gap: where races live
    return this.lock.run(() => {
      const t = this.tasks.get(id);
      if (!t) return { ok: false, reason: `task ${id} gone` };
      if (!this.claimable(t))
        return { ok: false, reason: `already ${t.status} (owner: ${t.owner ?? "none"})` };
      t.owner = owner;
      t.status = "in_progress";
      return { ok: true, reason: "claimed" };
    });
  }

  async complete(id: string, result: string): Promise<void> {
    return this.lock.run(() => {
      const t = this.tasks.get(id);
      if (t) {
        t.status = "done";
        t.result = result;
      }
    });
  }
}

// ── One tool a worker can use while running a claimed task ───────────────────
const TOOLS = [
  {
    type: "function" as const,
    name: "write_file",
    description: "Write a short text artifact for the current task.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "File name (no directories)." },
        content: { type: "string", description: "The text to write." },
      },
      required: ["filename", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function writeArtifact(scratch: string, filename: string, content: string): string {
  const safe = path.basename(filename); // never let a task escape the scratch dir
  fs.mkdirSync(scratch, { recursive: true });
  const p = path.join(scratch, safe);
  fs.writeFileSync(p, content);
  return `wrote ${content.length} bytes to ${p}`;
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

async function callModel(input: unknown[], worker: string, task: Task): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions:
        `You are worker '${worker}' completing a task. Call write_file once to ` +
        `save a short artifact, then reply with a one-line result. Act, don't explain.`,
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "low" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input, worker, task);
}

// Scripted stand-in: one write_file call, then a one-line result message.
function offlineModel(input: unknown[], worker: string, task: Task): OutputItem[] {
  const done = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (done === 0) {
    return [
      {
        type: "function_call",
        id: `call_${task.id}`,
        call_id: `call_${task.id}`,
        name: "write_file",
        arguments: JSON.stringify({
          filename: `${task.id}.md`,
          content: `# ${task.title}\n\nArtifact produced by worker '${worker}'.\n`,
        }),
      },
    ];
  }
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: `[offline demo] '${task.title}' done by ${worker} — artifact saved.`,
        },
      ],
    },
  ];
}

// ── Run one claimed task in the worker's OWN context (its own thread) ───────
async function runTask(worker: string, task: Task, scratch: string): Promise<string> {
  const input: unknown[] = [
    { role: "user", content: `Complete this task: "${task.title}".` },
  ];
  await sleep(WORK_MS); // the task holds the worker for a while, like real work
  for (let step = 0; step < 6; step++) {
    const output = await callModel(input, worker, task);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        for (const c of item.content ?? [])
          if (c.type === "output_text" && c.text) return c.text;
      return "(no result)";
    }
    for (const call of calls) {
      const { filename, content } = JSON.parse(call.arguments ?? "{}") as {
        filename: string;
        content: string;
      };
      const out = writeArtifact(scratch, filename, content);
      input.push({ type: "function_call_output", call_id: call.call_id, output: out });
    }
  }
  return "(max steps)";
}

// ── NEW in s17: the self-claiming worker loop ────────────────────────────────
// WORK (run a claimed task) -> IDLE (poll the board) -> SHUTDOWN (all settled).
// No lead assigns anything; the worker finds its own next task.
async function worker(name: string, board: TaskBoard, scratch: string): Promise<void> {
  say(name, "online — polling the board");
  let idlePolls = 0;
  for (;;) {
    const task = board.scan();
    if (!task) {
      if (board.allSettled()) {
        say(name, "\x1b[32mboard is done — shutting down\x1b[0m");
        return;
      }
      // Nothing claimable right now (a dependency may still be running).
      if (!board.anyBusy() && ++idlePolls > 50) {
        say(name, "no reachable work — shutting down");
        return;
      }
      await sleep(POLL_MS);
      continue;
    }
    idlePolls = 0;
    const res = await board.claim(task.id, name);
    if (!res.ok) {
      say(name, `\x1b[33mrace LOST\x1b[0m on ${task.id} — ${res.reason}; re-scanning`);
      continue; // someone else won; go find the next task
    }
    say(name, `\x1b[35mclaimed\x1b[0m ${task.id}: ${task.title}`);
    const result = await runTask(name, task, scratch);
    await board.complete(task.id, result);
    say(name, `\x1b[32mdone\x1b[0m ${task.id} → ${result}`);
  }
}

// ── Self-running narrated demo ────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s17: Self-Claiming Workers (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Two idle workers claim tasks off a shared board.\n"
      : `Model: ${MODEL}. Two idle workers claim tasks off a shared board.\n`
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s17-scratch-"));
  const board = new TaskBoard();
  board.add({ id: "t1", title: "Design the DB schema", status: "pending", blockedBy: [] });
  board.add({ id: "t2", title: "Write the API routes", status: "pending", blockedBy: [] });
  board.add({ id: "t3", title: "Write the tests", status: "pending", blockedBy: ["t1", "t2"] });

  say("board", `seeded ${board.all().length} tasks (t3 is blocked by t1 + t2)`);
  // No lead assigns work. alice and bob both wake idle, both scan, both race
  // for the same head task (t1) — watch one win and the other take t2.
  await Promise.all([
    worker("alice", board, scratch),
    worker("bob", board, scratch),
  ]);

  console.log("\nFinal board:");
  for (const t of board.all()) {
    console.log(
      `  ${t.id}  ${t.status.padEnd(11)} owner=${(t.owner ?? "-").padEnd(6)} ${t.title}`
    );
  }
  console.log(`\nArtifacts in ${scratch}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
