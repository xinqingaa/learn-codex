#!/usr/bin/env tsx
/**
 * s16_team_protocols/code.ts — Coordination Contracts (Codex-style, in TypeScript)
 *
 * s15's teammates traded loose, natural-language messages. That can't answer
 * "which request does this result belong to?". This chapter wraps every message
 * in a TYPED ENVELOPE — { id, from, to, kind, payload } — where kind is
 * request | response | broadcast. A LEAD routes work to teammates as requests,
 * a broadcast reaches everyone, and each response carries the id of the request
 * it answers, so the lead can correlate results to requests exactly:
 *
 *                     request  {id:r1, kind:"request"}
 *        ┌──────┐  ───────────────────►  ┌───────────┐
 *        │      │                        │ teammate  │── runs the task
 *        │ LEAD │  ◄───────────────────  └───────────┘
 *        │      │   response {id:r9,     answers r1
 *        │      │             kind:"response", replyTo:"r1"}
 *        └──────┘  ─── broadcast {kind:"broadcast"} ──► ALL teammates
 *
 * Run it (self-running narrated demo):
 *     npm install
 *     npx tsx s16_team_protocols/code.ts                       # offline demo
 *     OPENAI_API_KEY=sk-... npx tsx s16_team_protocols/code.ts # real model
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

// ── NEW in s16: the typed envelope — the team's coordination contract ───────
type Kind = "request" | "response" | "broadcast";
type Envelope = {
  id: string; // unique id; a request's id is what its response correlates to
  from: string;
  to: string; // a teammate name, or "*" for a broadcast
  kind: Kind;
  payload: string;
  replyTo?: string; // set on a response: the id of the request it answers
};

let seq = 0;
const nextId = (p: string) => `${p}_${String(++seq).padStart(3, "0")}`;

// A bus that routes envelopes to per-agent mailboxes (built on s15's idea).
class Bus {
  private boxes = new Map<string, Envelope[]>();
  send(env: Envelope): void {
    const targets = env.kind === "broadcast" ? [...this.boxes.keys()] : [env.to];
    for (const t of targets) {
      if (t === env.from) continue; // never echo a broadcast back to its sender
      this.boxes.set(t, [...(this.boxes.get(t) ?? []), env]);
      const tag = env.kind === "broadcast" ? `\x1b[34mbroadcast\x1b[0m` : env.kind;
      say("bus", `${tag} ${env.from} → ${t} [${env.id}] ${env.payload.slice(0, 44)}`);
    }
  }
  register(name: string): void {
    if (!this.boxes.has(name)) this.boxes.set(name, []);
  }
  async recv(name: string, timeoutMs = 15_000): Promise<Envelope | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const box = this.boxes.get(name);
      if (box && box.length > 0) return box.shift()!;
      if (Date.now() > deadline) return null;
      await sleep(20);
    }
  }
}

const BUS = new Bus();

// ── A teammate's one work tool (kept tiny; the loop is unchanged since s01) ──
const TOOLS = [
  {
    type: "function" as const,
    name: "write_file",
    description: "Write a short artifact for the assigned request.",
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

async function callModel(input: unknown[], who: string): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions:
        `You are teammate '${who}'. Fulfill the assigned request by calling ` +
        `write_file once, then reply with a one-line result.`,
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "low" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input, who);
}

function offlineModel(input: unknown[], who: string): OutputItem[] {
  const done = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  const req = String((input[0] as { content?: string })?.content ?? "task");
  if (done === 0) {
    return [
      {
        type: "function_call",
        id: `call_${who}`,
        call_id: `call_${who}`,
        name: "write_file",
        arguments: JSON.stringify({
          filename: `${who}-${seq}.md`,
          content: `# ${req.slice(0, 40)}\n\nProduced by teammate '${who}'.\n`,
        }),
      },
    ];
  }
  return [
    {
      type: "message",
      content: [{ type: "output_text", text: `[offline demo] ${who} finished: ${req.slice(0, 40)}` }],
    },
  ];
}

// ── A teammate: loop on its mailbox; requests get work, broadcasts get noted ──
async function runWork(who: string, payload: string, scratch: string): Promise<string> {
  const input: unknown[] = [{ role: "user", content: payload }];
  for (let step = 0; step < 6; step++) {
    const output = await callModel(input, who);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        for (const c of item.content ?? [])
          if (c.type === "output_text" && c.text) return c.text;
      return "(no result)";
    }
    for (const c of calls) {
      const { filename, content } = JSON.parse(c.arguments ?? "{}") as {
        filename: string;
        content: string;
      };
      fs.writeFileSync(path.join(scratch, path.basename(filename)), content);
      input.push({ type: "function_call_output", call_id: c.call_id, output: `wrote ${filename}` });
    }
  }
  return "(max steps)";
}

// ── NEW in s16: dispatch by envelope kind; a response is keyed to its request ──
async function teammate(name: string, scratch: string, stopWhen: () => boolean): Promise<void> {
  BUS.register(name);
  say(name, "online — waiting for envelopes");
  for (;;) {
    if (stopWhen()) return;
    const env = await BUS.recv(name, 200);
    if (!env) continue;
    if (env.kind === "broadcast") {
      say(name, `\x1b[34mheard broadcast\x1b[0m [${env.id}] — noted, no reply needed`);
      continue;
    }
    if (env.kind === "request") {
      say(name, `\x1b[35maccepted request\x1b[0m [${env.id}] ${env.payload.slice(0, 40)}`);
      const result = await runWork(name, env.payload, scratch);
      BUS.send({
        id: nextId("resp"),
        from: name,
        to: env.from,
        kind: "response",
        payload: result,
        replyTo: env.id, // correlate back to the request
      });
    }
  }
}

// ── NEW in s16: the lead routes work and correlates responses by id ──────────
class Lead {
  private pending = new Map<string, { payload: string; result?: string }>();
  constructor(private name: string) {
    BUS.register(name);
  }
  broadcast(payload: string): void {
    BUS.send({ id: nextId("bcast"), from: this.name, to: "*", kind: "broadcast", payload });
  }
  request(to: string, payload: string): string {
    const id = nextId("req");
    this.pending.set(id, { payload });
    BUS.send({ id, from: this.name, to, kind: "request", payload });
    return id;
  }
  // Drain the lead's inbox; match each response to its pending request by replyTo.
  async collect(total: number): Promise<void> {
    let got = 0;
    while (got < total) {
      const env = await BUS.recv(this.name, 15_000);
      if (!env) break;
      if (env.kind !== "response" || !env.replyTo) continue;
      const req = this.pending.get(env.replyTo);
      if (!req) continue; // a response for an unknown request id: ignore
      req.result = env.payload;
      got++;
      say("lead", `\x1b[32mmatched\x1b[0m response [${env.id}] → request [${env.replyTo}]`);
    }
  }
  report(): void {
    console.log("\nLead's request ledger:");
    for (const [id, r] of this.pending) {
      console.log(`  ${id}  ${r.result ? "fulfilled" : "PENDING"}  ${r.payload.slice(0, 44)}`);
    }
  }
}

// ── Self-running narrated demo ────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s16: Coordination Contracts (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). A lead routes typed envelopes to teammates.\n"
      : `Model: ${MODEL}. A lead routes typed envelopes to teammates.\n`
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s16-team-"));
  const lead = new Lead("lead");
  let leadDone = false;
  const workers = [
    teammate("alice", scratch, () => leadDone),
    teammate("bob", scratch, () => leadDone),
  ];
  await sleep(50); // let both teammates register before the broadcast

  lead.broadcast("kickoff: we are documenting the agent loop today");
  lead.request("alice", "Write the 'agent loop' overview section");
  lead.request("bob", "Write the 'tool use' section");
  lead.request("alice", "Write the 'approval policy' section");

  await lead.collect(3); // collect exactly 3 correlated responses
  leadDone = true;
  lead.broadcast("all sections in — stand down");
  await Promise.all(workers);
  lead.report();
  say("main", `artifacts in ${scratch}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
