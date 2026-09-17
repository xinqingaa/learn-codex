#!/usr/bin/env tsx
/**
 * s15_agent_teams/code.ts — Multi-Agent V2 mailboxes (Codex-style)
 *
 * s06's sub-agent (`spawnSubagent`) waited in the parent until one summary
 * came back. (That tool was also named `task` in s06; it is not s12's board.)
 * Codex Multi-Agent V2 keeps children alive: spawn returns immediately, each
 * agent holds its own context, and they coordinate through a MAILBOX.
 *
 *      root  --spawn_agent-->  researcher (own loop)
 *        |                         |
 *        |                    send_message
 *        |                         v
 *        |                       writer  --write_file--> agent-loop.md
 *        |                         |
 *        +-- wait_agent <----- final (harness posts completion)
 *
 * Sending is `send_message` (queue, do not start a turn). Joining is
 * `wait_agent` (block on YOUR mailbox until a message or a child final).
 *
 * Run it (self-running narrated demo):
 *     npx tsx s15_agent_teams/code.ts                       # offline demo
 *     OPENAI_API_KEY=sk-... npx tsx s15_agent_teams/code.ts # real model
 */

import OpenAI from "openai";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const openai = OFFLINE ? null : new OpenAI();

const t0 = Date.now();
function say(actor: string, msg: string): void {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  console.log(`\x1b[2m${t}s\x1b[0m \x1b[36m${actor.padEnd(11)}\x1b[0m ${msg}`);
}

type Mail = { from: string; to: string; content: string };

// ── NEW in s15: per-agent mailbox (Codex `Mailbox` is an in-process channel) ─
class Mailbox {
  private boxes = new Map<string, Mail[]>();
  private waiters = new Map<string, Array<(m: Mail) => void>>();

  ensure(name: string): void {
    if (!this.boxes.has(name)) this.boxes.set(name, []);
  }

  send(from: string, to: string, content: string): void {
    this.ensure(to);
    const mail: Mail = { from, to, content };
    const pending = this.waiters.get(to);
    if (pending && pending.length > 0) pending.shift()!(mail);
    else this.boxes.get(to)!.push(mail);
    say("mailbox", `\x1b[35m${from}\x1b[0m → \x1b[35m${to}\x1b[0m: ${content.slice(0, 56)}`);
  }

  async recv(to: string, timeoutMs = 15_000): Promise<Mail | null> {
    this.ensure(to);
    const box = this.boxes.get(to)!;
    if (box.length > 0) return box.shift()!;
    return new Promise((resolve) => {
      const waiters = this.waiters.get(to) ?? [];
      const timer = setTimeout(() => resolve(null), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.waiters.set(to, waiters);
    });
  }
}

const BUS = new Mailbox();
const parentOf = new Map<string, string>();
const live = new Map<string, Promise<void>>();
type Spawn = { name: string; role: string; task: string; parent: string };
let pendingSpawns: Spawn[] = [];

function fn(
  name: string,
  description: string,
  properties: Record<string, { type: string; description?: string }>,
  required: string[]
) {
  return {
    type: "function" as const,
    name,
    description,
    parameters: { type: "object" as const, properties, required, additionalProperties: false },
    strict: true,
  };
}

const SPAWN = fn(
  "spawn_agent",
  "Spawn a named sub-agent. Returns immediately; the child runs in parallel.",
  {
    task_name: { type: "string", description: "Child name, e.g. researcher or writer." },
    message: { type: "string", description: "Initial task delivered to the child." },
  },
  ["task_name", "message"]
);
const SEND = fn(
  "send_message",
  "Queue a message on an existing agent's mailbox. Does not start a new turn.",
  {
    target: { type: "string", description: "task_name from spawn_agent." },
    message: { type: "string" },
  },
  ["target", "message"]
);
const WAIT = fn(
  "wait_agent",
  "Block until this agent's mailbox has a message or a child final (or timeout).",
  {},
  []
);
const GATHER = fn("gather_notes", "Collect raw research notes.", { topic: { type: "string" } }, ["topic"]);
const WRITE = fn(
  "write_file",
  "Write the final document to disk.",
  { filename: { type: "string" }, content: { type: "string" } },
  ["filename", "content"]
);

function toolsFor(role: string) {
  if (role === "root") return [SPAWN, SEND, WAIT];
  if (role === "researcher") return [GATHER, SEND];
  return [WAIT, WRITE, SEND];
}

type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

function instructionsFor(role: string): string {
  if (role === "root")
    return "You are the root agent. Spawn named children with spawn_agent, then wait_agent until they finish. Keep replies to one line.";
  if (role === "researcher")
    return "You are researcher. Gather notes, send_message the findings to 'writer', then stop. Keep replies to one line.";
  return "You are writer. wait_agent for findings, write agent-loop.md, then stop. Keep replies to one line.";
}

async function callModel(input: unknown[], role: string): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions: instructionsFor(role),
      input: input as never,
      tools: toolsFor(role),
      reasoning: { effort: "low" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input, role);
}

const call = (id: string, name: string, args: object): OutputItem => ({
  type: "function_call",
  id,
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});
const text = (t: string): OutputItem[] => [
  { type: "message", content: [{ type: "output_text", text: `[offline demo] ${t}` }] },
];

function offlineModel(input: unknown[], role: string): OutputItem[] {
  const done = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (role === "root") {
    if (done === 0)
      return [
        call("s1", "spawn_agent", {
          task_name: "researcher",
          message: "Research how an agent loop works, then send_message findings to writer.",
        }),
        call("s2", "spawn_agent", {
          task_name: "writer",
          message: "wait_agent for findings, write them into agent-loop.md.",
        }),
      ];
    if (done === 2 || done === 3) return [call(`w${done}`, "wait_agent", {})];
    return text("root: both children posted a final — done.");
  }
  if (role === "researcher") {
    if (done === 0) return [call("r1", "gather_notes", { topic: "the agent loop" })];
    if (done === 1)
      return [
        call("r2", "send_message", {
          target: "writer",
          message:
            "Findings: an agent loop = while the model calls tools, run them and feed results back; it stops when no tool call remains.",
        }),
      ];
    return text("researcher: findings queued for writer.");
  }
  if (done === 0) return [call("w1", "wait_agent", {})];
  if (done === 1) {
    const findings = String((input.find((i) => (i as { type?: string }).type === "function_call_output") as { output?: string })?.output ?? "");
    return [
      call("w2", "write_file", {
        filename: "agent-loop.md",
        content: `# The Agent Loop\n\n${findings}\n\n— written by the writer agent\n`,
      }),
    ];
  }
  return text("writer: doc saved.");
}

function lastText(output: OutputItem[]): string {
  for (const item of output)
    for (const c of item.content ?? []) if (c.type === "output_text" && c.text) return c.text;
  return "done";
}

async function runTool(name: string, args: Record<string, string>, self: string, scratch: string): Promise<string> {
  if (name === "gather_notes") return `notes on "${args.topic}": loop, tools, feed-back, stop.`;
  if (name === "write_file") {
    const p = path.join(scratch, path.basename(args.filename));
    fs.writeFileSync(p, args.content);
    return `wrote ${args.content.length} bytes to ${p}`;
  }
  if (name === "spawn_agent") {
    if (self !== "root") return "only the root agent can spawn";
    const child = args.task_name;
    BUS.ensure(child);
    pendingSpawns.push({ name: child, role: child, task: args.message, parent: self });
    return `spawned ${child}`;
  }
  if (name === "send_message") {
    BUS.send(self, args.target, args.message);
    return `queued for ${args.target}`;
  }
  if (name === "wait_agent") {
    const msg = await BUS.recv(self);
    return msg ? `[mailbox from ${msg.from}] ${msg.content}` : "(mailbox timeout)";
  }
  return `unknown tool ${name}`;
}

function flushSpawns(scratch: string): void {
  const batch = pendingSpawns;
  pendingSpawns = [];
  for (const s of batch) {
    parentOf.set(s.name, s.parent);
    live.set(s.name, runAgent(s.name, s.role, s.task, scratch));
  }
}

async function runAgent(name: string, role: string, task: string, scratch: string): Promise<void> {
  say(name, `online as \x1b[35m${role}\x1b[0m — own context, own loop`);
  const input: unknown[] = [{ role: "user", content: task }];
  let closing = "done";
  for (let step = 0; step < 8; step++) {
    const output = await callModel(input, role);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      closing = lastText(output);
      say(name, `\x1b[32m${closing}\x1b[0m`);
      break;
    }
    for (const c of calls) {
      const args = JSON.parse(c.arguments ?? "{}") as Record<string, string>;
      const result = await runTool(c.name ?? "", args, name, scratch);
      if (c.name === "wait_agent") say(name, `← wait_agent ${result.slice(0, 52)}`);
      else say(name, `→ ${c.name}(${(args.task_name ?? args.target ?? args.filename ?? args.topic ?? "").slice(0, 28)})`);
      input.push({ type: "function_call_output", call_id: c.call_id, output: result });
    }
    flushSpawns(scratch);
  }
  const parent = parentOf.get(name);
  if (parent) BUS.send(name, parent, `final: ${closing}`);
}

async function main(): Promise<void> {
  console.log("s15: Multi-Agent V2 mailboxes (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Root spawns two children over a mailbox.\n"
      : `Model: ${MODEL}. Root spawns two children over a mailbox.\n`
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s15-team-"));
  BUS.ensure("root");
  await runAgent(
    "root",
    "root",
    "Spawn researcher and writer to research the agent loop and write agent-loop.md. wait_agent until both finish.",
    scratch
  );
  await Promise.all([...live.values()]);

  const doc = path.join(scratch, "agent-loop.md");
  say("main", `team finished — shared artifact at ${doc}`);
  console.log("\n--- agent-loop.md ---");
  console.log(fs.readFileSync(doc, "utf8").trim());
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
