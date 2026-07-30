#!/usr/bin/env tsx
/**
 * s12_task_system/code.ts — The Shared Task Board (Codex-style, in TypeScript)
 *
 * s05's update_plan is a checklist the model rewrites for itself: ephemeral,
 * single-agent, no dependencies. A real project needs a *task board* — tasks
 * with statuses, an owner, and a dependency graph, that the agent reads and
 * updates through tools as it plans and executes a multi-part goal:
 *
 *     create_task ──> pending ──claim_task──> in_progress ──complete_task──> completed
 *                        ▲                                        |
 *                        └──────── blockedBy: can't start ────────┘
 *                            until every dependency is completed
 *
 * The loop is s01's; the only change is a dispatch map with five new tools the
 * model calls to work the board (and `shell` to do the actual work):
 *
 *     +-------+   create/claim/complete   +------------+      +--------+
 *     | Model | ------------------------> |  TaskBoard | <--> |  shell |
 *     +-------+   <----------------------  +------------+      +--------+
 *                board state as tool output
 *
 * Run it:
 *     npm install
 *     npx tsx s12_task_system/code.ts          # offline demo: build & work a 4-task board
 *     OPENAI_API_KEY=sk-... npx tsx s12_task_system/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

const INSTRUCTIONS =
  `You are a coding agent in ${CWD}. Break the goal into tasks on the task board: ` +
  `create_task for each piece (declare blockedBy for dependencies), then work the board ` +
  `in dependency order — claim_task a ready task, do the work with shell, complete_task. ` +
  `Never claim a task whose dependencies are not all completed.`;

// ── NEW in s12: a shared TaskBoard (statuses, owner, dependency graph) ──────
type TaskStatus = "pending" | "in_progress" | "completed";
type Task = {
  id: string;
  subject: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: string[];
};

class TaskBoard {
  private tasks = new Map<string, Task>();
  private seq = 0;

  create(subject: string, blockedBy: string[] = []): Task {
    const task: Task = { id: `t${++this.seq}`, subject, status: "pending", owner: null, blockedBy };
    this.tasks.set(task.id, task);
    return task;
  }
  list(): Task[] {
    return [...this.tasks.values()];
  }
  // A task can start only when every one of its dependencies is completed.
  canStart(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    return t.blockedBy.every((dep) => this.tasks.get(dep)?.status === "completed");
  }
  claim(id: string, owner: string): string {
    const t = this.tasks.get(id);
    if (!t) return `Error: no such task ${id}`;
    if (t.status !== "pending") return `Error: ${id} is ${t.status}, cannot claim`;
    if (!this.canStart(id)) {
      const waiting = t.blockedBy.filter((d) => this.tasks.get(d)?.status !== "completed");
      return `Error: ${id} is blocked by unfinished ${JSON.stringify(waiting)}`;
    }
    t.owner = owner;
    t.status = "in_progress";
    return `Claimed ${id} (${t.subject}) — owner ${owner}`;
  }
  complete(id: string): string {
    const t = this.tasks.get(id);
    if (!t) return `Error: no such task ${id}`;
    t.status = "completed";
    // Completing a task may unblock the tasks that were waiting on it.
    const unblocked = this.list()
      .filter((x) => x.status === "pending" && x.blockedBy.includes(id) && this.canStart(x.id))
      .map((x) => x.id);
    return `Completed ${id} (${t.subject})` + (unblocked.length ? ` — unblocked: ${unblocked.join(", ")}` : "");
  }
  render(): string {
    const icon: Record<TaskStatus, string> = { pending: "○", in_progress: "◐", completed: "✓" };
    const lines = this.list().map((t) => {
      const deps = t.blockedBy.length ? `  (needs ${t.blockedBy.join(",")})` : "";
      const blocked = t.status === "pending" && !this.canStart(t.id) ? "  [blocked]" : "";
      return `  ${icon[t.status]} ${t.id} ${t.subject}${deps}${blocked}`;
    });
    const out = `## Task Board\n${lines.join("\n")}`;
    console.log(`\x1b[35m${out}\x1b[0m`);
    return out;
  }
}

const board = new TaskBoard();

// ── Tool registry: a dispatch map from tool name to handler (from s02) ──────
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

const DISPATCH: Record<string, (args: Record<string, unknown>) => string> = {
  create_task: (a) => {
    const t = board.create(String(a.subject), (a.blockedBy as string[]) ?? []);
    return `Created ${t.id} (${t.subject})` + (t.blockedBy.length ? ` blockedBy ${t.blockedBy.join(",")}` : "");
  },
  list_tasks: () => board.render(),
  claim_task: (a) => board.claim(String(a.id), "agent"),
  complete_task: (a) => board.complete(String(a.id)),
  shell: (a) => {
    console.log(`\x1b[33m$ ${String(a.command)}\x1b[0m`);
    return runShell(String(a.command));
  },
};

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const TOOLS = [
  { type: "function" as const, name: "create_task", strict: true,
    description: "Create a task on the shared board. Declare blockedBy for dependencies.",
    parameters: obj({ subject: str("Short task title."), blockedBy: { type: "array", items: { type: "string" }, description: "IDs that must finish first." } }, ["subject", "blockedBy"]) },
  { type: "function" as const, name: "list_tasks", strict: true,
    description: "List every task with its status and dependencies.",
    parameters: obj({}, []) },
  { type: "function" as const, name: "claim_task", strict: true,
    description: "Claim a pending, unblocked task and mark it in_progress.",
    parameters: obj({ id: str("The task id, e.g. t1.") }, ["id"]) },
  { type: "function" as const, name: "complete_task", strict: true,
    description: "Mark an in_progress task completed; may unblock dependents.",
    parameters: obj({ id: str("The task id.") }, ["id"]) },
  { type: "function" as const, name: "shell", strict: true,
    description: "Run a shell command and return its combined stdout+stderr.",
    parameters: obj({ command: str("The shell command to run.") }, ["command"]) },
];

// ── Model adapter (same Responses-API shape as s01) ─────────────────────────
type OutputItem = {
  type: string; id?: string; call_id?: string; name?: string; arguments?: string;
  content?: { type: string; text?: string }[];
};
const openai = OFFLINE ? null : new OpenAI();

async function callModel(input: unknown[]): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL, instructions: INSTRUCTIONS, input: input as never, tools: TOOLS,
      reasoning: { effort: "medium" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input);
}

// ── Offline demo: a scripted model that builds a board and works it ─────────
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  const call = (name: string, args: Record<string, unknown>): OutputItem => ({
    type: "function_call", id: `call_${ran}`, call_id: `call_${ran}`, name, arguments: JSON.stringify(args),
  });
  // Build a 4-task DAG, try to claim a blocked task (fails), then work in order.
  const script: Array<[string, Record<string, unknown>]> = [
    ["create_task", { subject: "Set up database schema", blockedBy: [] }],
    ["create_task", { subject: "Build API endpoints", blockedBy: ["t1"] }],
    ["create_task", { subject: "Write tests", blockedBy: ["t2"] }],
    ["create_task", { subject: "Write docs", blockedBy: ["t1"] }],
    ["list_tasks", {}],
    ["claim_task", { id: "t2" }], // blocked by t1 → the board refuses
    ["claim_task", { id: "t1" }],
    ["shell", { command: "echo 'creating schema...'" }],
    ["complete_task", { id: "t1" }], // unblocks t2 and t4
    ["claim_task", { id: "t2" }],
    ["shell", { command: "echo 'building endpoints...'" }],
    ["complete_task", { id: "t2" }], // unblocks t3
    ["list_tasks", {}],
  ];
  if (ran < script.length) return [call(...script[ran])];
  return [{
    type: "message",
    content: [{ type: "output_text", text:
      `[offline demo] I built a 4-task board with dependencies (t2 needs t1, t3 needs t2, ` +
      `t4 needs t1). Claiming t2 first was REFUSED — blocked by t1. So I claimed t1, did the ` +
      `work, completed it, which unblocked t2 and t4; then claimed and completed t2, unlocking ` +
      `t3. The dependency graph decided what could run, not me. Set OPENAI_API_KEY for a real model.` }],
  }];
}

// ── The agent loop: s01's loop + a dispatch map (from s02) ──────────────────
async function agentLoop(input: unknown[]): Promise<void> {
  for (;;) {
    const output = await callModel(input);
    input.push(...output);

    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output) {
        if (item.type === "message") {
          for (const c of item.content ?? []) if (c.type === "output_text" && c.text) console.log(c.text);
        }
      }
      return;
    }
    for (const call of calls) {
      const handler = DISPATCH[call.name ?? ""];
      const result = handler
        ? handler(JSON.parse(call.arguments ?? "{}") as Record<string, unknown>)
        : `Error: unknown tool ${call.name}`;
      if (call.name !== "shell" && call.name !== "list_tasks") console.log(`\x1b[90m→ ${result}\x1b[0m`);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL (async-iterator, robust to piped stdin) ──────
async function main(): Promise<void> {
  console.log("s12: The Shared Task Board (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a multi-part goal, or q to quit.\n"
      : `Model: ${MODEL}. Type a multi-part goal, or q to quit.\n`
  );
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const thread: unknown[] = [];
  process.stdout.write("\x1b[36ms12 >> \x1b[0m");
  for await (const line of rl) {
    const query = line.trim();
    if (!query || ["q", "exit"].includes(query.toLowerCase())) break;
    thread.push({ role: "user", content: query });
    try {
      await agentLoop(thread);
    } catch (err) {
      console.error("agent error:", err instanceof Error ? err.message : err);
    }
    console.log();
    process.stdout.write("\x1b[36ms12 >> \x1b[0m");
  }
  rl.close();
}

main();
