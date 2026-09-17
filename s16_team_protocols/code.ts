#!/usr/bin/env tsx
/**
 * s16_team_protocols/code.ts — Typed envelopes + id correlation
 *
 * s15's mailbox carried loose strings. Codex already types the header
 * (NEW_TASK / MESSAGE / FINAL_ANSWER) and a trigger_turn bit. This chapter
 * keeps those ideas, then ADDS a teaching ledger: replyTo correlates N
 * in-flight requests — something Codex does not do (it addresses by agent
 * path, not by request id).
 *
 *      request  {id:req_002, triggerTurn}     ≈ NEW_TASK / followup
 *      response {replyTo:req_002}             ≈ FINAL_ANSWER + teaching id
 *      broadcast {to:"*"}                     teaching extra (no Codex kind)
 *
 * Run it:
 *     npx tsx s16_team_protocols/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s16_team_protocols/code.ts
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

// ── NEW in s16: typed envelope (Codex header + teaching replyTo ledger) ─────
type Kind = "request" | "response" | "broadcast";
type Envelope = {
  id: string;
  from: string;
  to: string; // teammate name, or "*" for a broadcast
  kind: Kind;
  payload: string;
  replyTo?: string; // teaching extra: correlate a response to a request
  triggerTurn: boolean; // Codex: NEW_TASK/followup = true, MESSAGE = false
};

let seq = 0;
const nextId = (p: string) => `${p}_${String(++seq).padStart(3, "0")}`;

// Same waiter mailbox as s15, now carrying envelopes and fanning out broadcasts.
class Mailbox {
  private boxes = new Map<string, Envelope[]>();
  private waiters = new Map<string, Array<(e: Envelope) => void>>();

  ensure(name: string): void {
    if (!this.boxes.has(name)) this.boxes.set(name, []);
  }

  send(env: Envelope): void {
    const targets = env.kind === "broadcast" ? [...this.boxes.keys()] : [env.to];
    for (const t of targets) {
      if (t === env.from) continue;
      this.ensure(t);
      const pending = this.waiters.get(t);
      if (pending && pending.length > 0) pending.shift()!(env);
      else this.boxes.get(t)!.push(env);
      const tag = env.kind === "broadcast" ? "\x1b[34mbroadcast\x1b[0m" : env.kind;
      say("mailbox", `${tag} ${env.from} → ${t} [${env.id}] ${env.payload.slice(0, 40)}`);
    }
  }

  async recv(to: string, timeoutMs = 15_000): Promise<Envelope | null> {
    this.ensure(to);
    const box = this.boxes.get(to)!;
    if (box.length > 0) return box.shift()!;
    return new Promise((resolve) => {
      const waiters = this.waiters.get(to) ?? [];
      const timer = setTimeout(() => resolve(null), timeoutMs);
      waiters.push((e) => {
        clearTimeout(timer);
        resolve(e);
      });
      this.waiters.set(to, waiters);
    });
  }
}

const BUS = new Mailbox();

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
      instructions: `You are teammate '${who}'. Call write_file once, then a one-line result.`,
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "low" },
    });
    return resp.output as unknown as OutputItem[];
  }
  const done = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  const req = String((input[0] as { content?: string })?.content ?? "task");
  if (done === 0) {
    return [
      {
        type: "function_call",
        id: `call_${who}_${seq}`,
        call_id: `call_${who}_${seq}`,
        name: "write_file",
        arguments: JSON.stringify({
          filename: `${who}-${seq}.md`,
          content: `# ${req.slice(0, 40)}\n\nProduced by teammate '${who}'.\n`,
        }),
      },
    ];
  }
  return [{ type: "message", content: [{ type: "output_text", text: `[offline demo] ${who} finished: ${req.slice(0, 40)}` }] }];
}

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
      const { filename, content } = JSON.parse(c.arguments ?? "{}") as { filename: string; content: string };
      fs.writeFileSync(path.join(scratch, path.basename(filename)), content);
      input.push({ type: "function_call_output", call_id: c.call_id, output: `wrote ${filename}` });
    }
  }
  return "(max steps)";
}

// Dispatch by kind. A response is posted by the harness (Codex FINAL_ANSWER),
// with teaching replyTo so root can match it to a pending request.
async function worker(name: string, scratch: string): Promise<void> {
  BUS.ensure(name);
  say(name, "online — waiting for envelopes");
  for (;;) {
    const env = await BUS.recv(name, 15_000);
    if (!env) continue;
    if (env.kind === "broadcast") {
      say(name, `\x1b[34mheard broadcast\x1b[0m [${env.id}] — no reply`);
      if (env.payload.includes("stand down")) return;
      continue;
    }
    if (env.kind === "request") {
      say(name, `\x1b[35maccepted request\x1b[0m [${env.id}] ${env.payload.slice(0, 40)}`);
      const result = await runWork(name, env.payload, scratch);
      BUS.send({
        id: nextId("final"),
        from: name,
        to: env.from,
        kind: "response",
        payload: result,
        replyTo: env.id,
        triggerTurn: false,
      });
    }
  }
}

// ── NEW in s16: root's pending ledger, keyed by request id ──────────────────
class Root {
  private pending = new Map<string, { to: string; payload: string; result?: string }>();
  constructor(private name: string) {
    BUS.ensure(name);
  }
  broadcast(payload: string): void {
    BUS.send({
      id: nextId("bcast"),
      from: this.name,
      to: "*",
      kind: "broadcast",
      payload,
      triggerTurn: false,
    });
  }
  request(to: string, payload: string): string {
    const id = nextId("req");
    this.pending.set(id, { to, payload });
    BUS.send({ id, from: this.name, to, kind: "request", payload, triggerTurn: true });
    return id;
  }
  async collect(total: number): Promise<void> {
    let got = 0;
    while (got < total) {
      const env = await BUS.recv(this.name, 15_000);
      if (!env) break;
      if (env.kind !== "response" || !env.replyTo) continue;
      const req = this.pending.get(env.replyTo);
      if (!req) {
        say("root", `\x1b[33mignored\x1b[0m [${env.id}] — unknown replyTo [${env.replyTo}]`);
        continue;
      }
      req.result = env.payload;
      got++;
      say("root", `\x1b[32mmatched\x1b[0m [${env.id}] → request [${env.replyTo}] (${req.to})`);
    }
  }
  report(): void {
    console.log("\nRoot request ledger:");
    for (const [id, r] of this.pending) {
      console.log(`  ${id}  ${r.result ? "fulfilled" : "PENDING"}  ${r.to}: ${r.payload.slice(0, 40)}`);
    }
  }
}

async function main(): Promise<void> {
  console.log("s16: Typed envelopes + id correlation");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Root routes three requests and matches by replyTo.\n"
      : `Model: ${MODEL}. Root routes three requests and matches by replyTo.\n`
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "s16-team-"));
  const root = new Root("root");
  BUS.ensure("alice");
  BUS.ensure("bob");
  const workers = [worker("alice", scratch), worker("bob", scratch)];
  await sleep(20);

  root.broadcast("kickoff: we are documenting the agent loop today");
  root.request("alice", "Write the 'agent loop' overview section");
  root.request("bob", "Write the 'tool use' section");
  root.request("alice", "Write the 'approval policy' section");
  BUS.send({
    id: nextId("final"),
    from: "bob",
    to: "root",
    kind: "response",
    payload: "ghost: no such request",
    replyTo: "req_999",
    triggerTurn: false,
  });

  await root.collect(3);
  root.broadcast("all sections in — stand down");
  await Promise.all(workers);
  root.report();
  say("main", `artifacts in ${scratch}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
