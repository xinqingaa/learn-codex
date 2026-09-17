#!/usr/bin/env tsx
/**
 * s17_autonomous_agents/code.ts — Self-claiming workers (teaching pull)
 *
 * s16's root still pointed at each teammate: three requests, three replies.
 * Codex Multi-Agent V2 stays parent-orchestrated (spawn_agent / followup).
 * This chapter ADDS a teaching pull loop on s12's TaskBoard: idle workers
 * SCAN without a lock, then CLAIM inside a critical section. Two workers
 * may read the same pending task; only one wins.
 *
 *      alice ──scan (unlocked)──►  TaskBoard   t1 pending
 *      bob   ──scan (unlocked)──►     │
 *      both ──claim (locked re-check)─┘  one WON, one LOST → re-scan
 *
 * Codex does not have this board. Directory isolation is s18; Cloud containers are s23.
 *
 * Run it:
 *     npx tsx s17_autonomous_agents/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s17_autonomous_agents/code.ts
 */

import OpenAI from "openai";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const openai = OFFLINE ? null : new OpenAI();

const POLL_MS = 120;
const CLAIM_LATENCY_MS = 40; // widen the TOCTOU gap so the race is visible
const WORK_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
function say(actor: string, msg: string): void {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  console.log(`\x1b[2m${t}s\x1b[0m \x1b[36m${actor.padEnd(6)}\x1b[0m ${msg}`);
}

type TaskStatus = "pending" | "in_progress" | "done";
type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  owner?: string;
  result?: string;
  blockedBy: string[];
};

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
  scan(): Task | undefined {
    return this.all().find((t) => this.claimable(t));
  }
  allSettled(): boolean {
    return this.all().every((t) => t.status === "done");
  }
  anyBusy(): boolean {
    return this.all().some((t) => t.status === "in_progress");
  }

  // ── NEW in s17: concurrent claim (s12's claim under a race) ──────────────
  // scan() is already stale. Sleep models a storage round-trip; the re-check
  // inside the mutex is the only check that counts. Codex has no such board.
  async claim(id: string, owner: string): Promise<{ ok: boolean; reason: string }> {
    await sleep(CLAIM_LATENCY_MS);
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

const TOOLS = [
  {
    type: "function" as const,
    name: "write_file",
    description: "Write a short text artifact for the current task.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "File name, no directories." },
        content: { type: "string" },
      },
      required: ["filename", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
];

type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

async function callModel(input: unknown[], who: string, task: Task): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions: `You are worker '${who}'. Call write_file once, then a one-line result.`,
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "low" },
    });
    return resp.output as unknown as OutputItem[];
  }
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
          content: `# ${task.title}\n\nArtifact produced by worker '${who}'.\n`,
        }),
      },
    ];
  }
  return [
    {
      type: "message",
      content: [{ type: "output_text", text: `[offline demo] '${task.title}' done by ${who}.` }],
    },
  ];
}

async function runTask(who: string, task: Task, scratch: string): Promise<string> {
  const input: unknown[] = [{ role: "user", content: `Complete this task: "${task.title}".` }];
  await sleep(WORK_MS);
  for (let step = 0; step < 6; step++) {
    const output = await callModel(input, who, task);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        for (const c of item.content ?? [])
          if (c.type === "output_text" && c.text) return c.text;
      return "(no result)";
    }
    for (const call of calls) {
      const { filename, content } = JSON.parse(call.arguments ?? "{}") as { filename: string; content: string };
      const safe = path.basename(filename);
      fs.writeFileSync(path.join(scratch, safe), content);
      input.push({ type: "function_call_output", call_id: call.call_id, output: `wrote ${safe}` });
    }
  }
  return "(max steps)";
}

// ── NEW in s17: worker loop — WORK → IDLE poll → SHUTDOWN ───────────────────
// Teaching workers, not Codex spawn_agent children. Codex idle waits on mail
// with trigger_turn; this loop polls the teaching board instead.
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
      continue;
    }
    say(name, `\x1b[35mclaimed\x1b[0m ${task.id}: ${task.title}`);
    const result = await runTask(name, task, scratch);
    await board.complete(task.id, result);
    say(name, `\x1b[32mdone\x1b[0m ${task.id} → ${result}`);
  }
}

async function main(): Promise<void> {
  console.log("s17: Self-claiming workers (teaching pull)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Root seeds the board; workers claim.\n"
      : `Model: ${MODEL}. Root seeds the board; workers claim.\n`
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s17-scratch-"));
  const board = new TaskBoard();
  // Root writes tasks and stops assigning — the s16 bottleneck, inverted.
  board.add({ id: "t1", title: "Design the DB schema", status: "pending", blockedBy: [] });
  board.add({ id: "t2", title: "Write the API routes", status: "pending", blockedBy: [] });
  board.add({ id: "t3", title: "Write the tests", status: "pending", blockedBy: ["t1", "t2"] });
  say("root", "seeded t1, t2, t3 (t3 blocked by t1+t2) — not assigning");

  await Promise.all([worker("alice", board, scratch), worker("bob", board, scratch)]);

  console.log("\nFinal board:");
  for (const t of board.all()) {
    console.log(`  ${t.id}  ${t.status.padEnd(11)} owner=${(t.owner ?? "-").padEnd(6)} ${t.title}`);
  }
  say("main", `artifacts in ${scratch}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
