#!/usr/bin/env tsx
/**
 * s15_agent_teams/code.ts — Teammate Mailboxes (Codex-style, in TypeScript)
 *
 * s06's sub-agent was a temp worker: spawn it, get one result back, throw it
 * away. Some tasks are too big for that — they need teammates that keep their
 * OWN context and talk to each other while they work. This chapter gives each
 * named agent its own conversation and an ASYNC MAILBOX; sending a message is
 * just a tool call, and a teammate can block on its inbox waiting for input:
 *
 *      ┌──────────────┐   send_message   ┌──────────────┐
 *      │  researcher  │ ───────────────► │  mailbox:    │
 *      │ (own context)│                  │   "writer"   │
 *      └──────────────┘                  └──────┬───────┘
 *      ┌──────────────┐   wait_inbox            │ deliver
 *      │    writer    │ ◄───────────────────────┘
 *      │ (own context)│ ───────────────► writes the doc
 *      └──────────────┘
 *
 * One researches, the other writes. Neither shares a context window — they
 * share INFORMATION through messages. That's the whole idea of a team.
 *
 * Run it (self-running narrated demo):
 *     npm install
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
function say(actor: string, msg: string): void {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  console.log(`\x1b[2m${t}s\x1b[0m \x1b[36m${actor.padEnd(10)}\x1b[0m ${msg}`);
}

// ── NEW in s15: async mailboxes between named teammates ─────────────────────
// A loose message (the typed envelope is s16's job). Each teammate owns an
// inbox; send() appends, recv() blocks until something arrives (or times out).
type Message = { from: string; to: string; content: string; ts: number };

class MessageBus {
  private boxes = new Map<string, Message[]>();
  private waiters = new Map<string, ((m: Message) => void)[]>();

  send(from: string, to: string, content: string): void {
    const msg: Message = { from, to, content, ts: Date.now() };
    const pending = this.waiters.get(to);
    if (pending && pending.length > 0) {
      pending.shift()!(msg); // someone is blocked on wait_inbox → hand it over
    } else {
      const box = this.boxes.get(to) ?? [];
      box.push(msg);
      this.boxes.set(to, box);
    }
    say("bus", `\x1b[35m${from}\x1b[0m → \x1b[35m${to}\x1b[0m: ${content.slice(0, 56)}`);
  }

  // Block until a message arrives for `to` (bounded so a real run can't hang).
  async recv(to: string, timeoutMs = 15_000): Promise<Message | null> {
    const box = this.boxes.get(to);
    if (box && box.length > 0) return box.shift()!;
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

const BUS = new MessageBus();

// ── Tools a teammate can call. send_message / wait_inbox ARE the mailbox. ────
const TOOLS = [
  {
    type: "function" as const,
    name: "gather_notes",
    description: "Collect raw research notes about the topic.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "write_file",
    description: "Write the final document to disk.",
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
  {
    type: "function" as const,
    name: "send_message",
    description: "Send a message to a teammate's mailbox.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Teammate name." },
        content: { type: "string" },
      },
      required: ["to", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "wait_inbox",
    description: "Block until a message arrives in your inbox; returns it.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];

// ── Model adapter (same shape as s01), scripted per role when offline ───────
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

async function callModel(input: unknown[], role: string): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions:
        `You are the '${role}' on a two-agent team. Use your tools, coordinate ` +
        `over send_message / wait_inbox, and keep replies to one line.`,
      input: input as never,
      tools: TOOLS,
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

// The researcher gathers notes, hands them to the writer, then signs off.
function offlineModel(input: unknown[], role: string): OutputItem[] {
  const done = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (role === "researcher") {
    if (done === 0) return [call("r1", "gather_notes", { topic: "the agent loop" })];
    if (done === 1)
      return [
        call("r2", "send_message", {
          to: "writer",
          content:
            "Findings: an agent loop = while the model calls tools, run them and " +
            "feed results back; it stops when no tool call remains.",
        }),
      ];
    return text("researcher: notes sent to writer — my part is done.");
  }
  // writer
  if (done === 0) return [call("w1", "wait_inbox", {})];
  if (done === 1) {
    const findings = String(
      (input.find((i) => (i as { type?: string }).type === "function_call_output") as {
        output?: string;
      })?.output ?? ""
    );
    return [
      call("w2", "write_file", {
        filename: "agent-loop.md",
        content: `# The Agent Loop\n\n${findings}\n\n— written by the writer teammate\n`,
      }),
    ];
  }
  if (done === 2)
    return [call("w3", "send_message", { to: "researcher", content: "Doc written: agent-loop.md" })];
  return text("writer: doc saved and researcher notified — done.");
}

// ── NEW in s15: one teammate = its OWN context + its OWN loop ───────────────
// Each teammate keeps a private `input` array (its own context window). The
// mailbox tools are executed by the harness like any other tool — but their
// effect is on ANOTHER agent's context, not the filesystem.
async function runTool(
  name: string,
  args: Record<string, string>,
  self: string,
  scratch: string
): Promise<string> {
  if (name === "gather_notes") return `notes on "${args.topic}": loop, tools, feed-back, stop.`;
  if (name === "write_file") {
    const p = path.join(scratch, path.basename(args.filename));
    fs.writeFileSync(p, args.content);
    return `wrote ${args.content.length} bytes to ${p}`;
  }
  if (name === "send_message") {
    BUS.send(self, args.to, args.content);
    return `delivered to ${args.to}`;
  }
  if (name === "wait_inbox") {
    const msg = await BUS.recv(self);
    return msg ? `[inbox from ${msg.from}] ${msg.content}` : "(inbox timeout)";
  }
  return `unknown tool ${name}`;
}

async function teammate(name: string, role: string, task: string, scratch: string): Promise<void> {
  say(name, `online as \x1b[35m${role}\x1b[0m — own context, own loop`);
  const input: unknown[] = [{ role: "user", content: task }]; // private context
  for (let step = 0; step < 8; step++) {
    const output = await callModel(input, role);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        for (const c of item.content ?? [])
          if (c.type === "output_text" && c.text) say(name, `\x1b[32m${c.text}\x1b[0m`);
      return; // this teammate is done
    }
    for (const c of calls) {
      const args = JSON.parse(c.arguments ?? "{}") as Record<string, string>;
      if (c.name !== "wait_inbox") say(name, `→ ${c.name}(${(args.to ?? args.filename ?? args.topic ?? "").slice(0, 30)})`);
      const result = await runTool(c.name ?? "", args, name, scratch);
      input.push({ type: "function_call_output", call_id: c.call_id, output: result });
    }
  }
}

// ── Self-running narrated demo: one researches, one writes ──────────────────
async function main(): Promise<void> {
  console.log("s15: Teammate Mailboxes (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Two teammates split a task over mailboxes.\n"
      : `Model: ${MODEL}. Two teammates split a task over mailboxes.\n`
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s15-team-"));
  // No lead assigns steps one by one. Each teammate gets a goal and its own
  // context; the mailbox lets them coordinate the hand-off themselves.
  await Promise.all([
    teammate("researcher", "researcher", "Research how an agent loop works, then send your findings to 'writer'.", scratch),
    teammate("writer", "writer", "Wait for research findings, write them into agent-loop.md, then tell 'researcher' you're done.", scratch),
  ]);

  const doc = path.join(scratch, "agent-loop.md");
  say("main", `team finished — shared artifact at ${doc}`);
  console.log("\n--- agent-loop.md ---");
  console.log(fs.readFileSync(doc, "utf8").trim());
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
