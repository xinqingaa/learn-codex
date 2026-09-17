#!/usr/bin/env tsx
/**
 * s19_mcp_servers/code.ts — MCP tool bridge (Codex as a client)
 *
 * From s01–s18 the model only sees tools we wrote into the harness.
 * A company Jira / deploy system / wiki cannot be rewritten every time.
 *
 * Codex is an MCP *client*. At session start it reads [mcp_servers.<name>]
 * from ~/.codex/config.toml, spawns each stdio server, then:
 *   initialize → notifications/initialized → tools/list → tools/call
 * Discovered tools become ordinary function tools named mcp__<server>__<tool>
 * (legacy prefix still in Codex). tools/call uses the server's raw name.
 * The model has no connect_mcp tool.
 *
 * HTTP url, enabled_tools, OAuth, timeouts: s22. Plugins that bundle MCP: s24.
 * Codex *as* a server (`codex mcp-server`): s24 / s27. `codex mcp` is a
 * config manager (add/list/get/login/logout/remove), not that server.
 *
 * Teaching extra: this file is BOTH halves — run normally it is the client;
 * `--mcp-server <name>` makes it the stdio child. No network, no key.
 *
 *     npx tsx s19_mcp_servers/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s19_mcp_servers/code.ts
 */

import OpenAI from "openai";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const openai = OFFLINE ? null : new OpenAI();

const SELF = fileURLToPath(import.meta.url);
const NODE = process.execPath;
const t0 = Date.now();
function say(actor: string, msg: string): void {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  console.log(`\x1b[2m${t}s\x1b[0m \x1b[36m${actor.padEnd(6)}\x1b[0m ${msg}`);
}
const norm = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
type Json = Record<string, any>;

type FnTool = { type: "function"; name: string; description: string; parameters: Record<string, unknown>; strict: boolean };
type Handler = (args: Json) => Promise<string> | string;
const TOOLS: FnTool[] = [];
const REGISTRY = new Map<string, Handler>();
function register(tool: FnTool, handler: Handler): void { TOOLS.push(tool); REGISTRY.set(tool.name, handler); }
const fn = (name: string, description: string, parameters: Record<string, unknown>): FnTool =>
  ({ type: "function", name, description, parameters, strict: true });
const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> =>
  ({ type: "object", properties, required, additionalProperties: false });

// ── The two MCP servers this file can become (spawned as child processes) ────
type McpToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
const SERVERS: Record<string, { tools: McpToolDef[]; handlers: Record<string, (args: Json) => string> }> = {
  docs: {
    tools: [
      { name: "search", description: "Search the learn-codex notes. (readOnly)", inputSchema: obj({ query: { type: "string" } }, ["query"]) },
      { name: "get_page", description: "Fetch one note by id. (readOnly)", inputSchema: obj({ id: { type: "string" } }, ["id"]) },
    ],
    handlers: {
      search: (a) => `top hit for "${a.query}": s01 — the agent loop: while the model keeps calling tools, run them and feed each result back.`,
      get_page: (a) => `page ${a.id}: "s01 The Agent Loop — one loop & a shell is all you need."`,
    },
  },
  deploy: {
    tools: [
      { name: "trigger", description: "Trigger a deployment to an environment. (destructive)", inputSchema: obj({ env: { type: "string" } }, ["env"]) },
    ],
    handlers: {
      trigger: (a) => `deploy to ${a.env} queued as #42 (destructive — a real server would ask first)`,
    },
  },
};

// MCP stdio is newline-delimited JSON-RPC (not Content-Length). Logs go to stderr.
function runServer(name: string): void {
  const server = SERVERS[name];
  if (!server) { console.error(`unknown server "${name}"`); process.exit(1); }
  console.error(`[mcp:${name}] up on stdio (pid ${process.pid})`);
  const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    const { id, method, params } = JSON.parse(line) as Json;
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name, version: "0.1.0" }, capabilities: { tools: {} } } });
    } else if (method === "notifications/initialized") {
      // notification: no response
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: server.tools } });
    } else if (method === "tools/call") {
      const handler = server.handlers[params?.name];
      const text = handler ? handler(params?.arguments ?? {}) : `unknown tool "${params?.name}"`;
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } else if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  });
}

// What ~/.codex/config.toml would declare. Codex spawns these at session start.
const MCP_CONFIG: Record<string, { command: string; args: string[] }> = {
  docs: { command: NODE, args: ["--import", "tsx", SELF, "--mcp-server", "docs"] },
  deploy: { command: NODE, args: ["--import", "tsx", SELF, "--mcp-server", "deploy"] },
};

class McpClient {
  tools: McpToolDef[] = [];
  private seq = 0;
  private pending = new Map<number, (msg: Json) => void>();
  private buf = "";
  constructor(public name: string, private child: ChildProcess) {
    child.stdout!.on("data", (d) => this.onChunk(String(d)));
    child.stderr!.on("data", (d) => say(name, `\x1b[2m${String(d).trim()}\x1b[0m`));
  }
  private onChunk(s: string): void {
    this.buf += s;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Json;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
      }
    }
  }
  private request(method: string, params?: Json): Promise<Json> {
    const id = ++this.seq;
    say(this.name, `\x1b[34m→\x1b[0m ${method} ${params ? JSON.stringify(params) : ""}`.trim());
    return new Promise<Json>((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    }).then((result) => { say(this.name, `\x1b[34m←\x1b[0m ${JSON.stringify(result).slice(0, 96)}`); return result; });
  }
  async connect(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "learn-codex", version: "0.1.0" }, capabilities: {} });
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    this.tools = (await this.request("tools/list")).tools as McpToolDef[];
  }
  async callTool(tool: string, args: Json): Promise<string> {
    const res = await this.request("tools/call", { name: tool, arguments: args });
    return (res.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
  }
  close(): void { this.child.kill(); }
}

async function spawnMcp(name: string): Promise<McpClient> {
  const def = MCP_CONFIG[name];
  const child = spawn(def.command, def.args, { stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (e) => say(name, `\x1b[31mspawn error: ${e.message}\x1b[0m`));
  const client = new McpClient(name, child);
  await client.connect();
  say("bridge", `connected "${name}" → discovered: ${client.tools.map((t) => t.name).join(", ")}`);
  return client;
}

// Model sees mcp__<server>__<tool>. tools/call uses the raw t.name.
function bridgeTools(client: McpClient): void {
  for (const t of client.tools) {
    register(
      fn(`mcp__${norm(client.name)}__${norm(t.name)}`, `(MCP:${client.name}) ${t.description}`, t.inputSchema),
      (args) => client.callTool(t.name, args)
    );
  }
}

type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};
async function callModel(input: unknown[]): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions: "You are a coding agent. Answer using the mcp__* tools. Act, don't explain.",
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "low" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input);
}
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  const call = (n: number, name: string, args: Json): OutputItem =>
    ({ type: "function_call", id: `call_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args) });
  switch (ran) {
    case 0: return [call(1, "mcp__docs__search", { query: "agent loop" })];
    case 1: return [call(2, "mcp__docs__get_page", { id: "s01" })];
    case 2: return [call(3, "mcp__deploy__trigger", { env: "staging" })];
    default:
      return [{ type: "message", content: [{ type: "output_text", text:
        "[offline demo] Answered via three bridged MCP tools across two child-process servers: " +
        "docs.search + docs.get_page (readOnly) and deploy.trigger (destructive). The agent never " +
        "knew these were external processes — it only saw ordinary function tools named " +
        "mcp__<server>__<tool>. Set OPENAI_API_KEY to drive it for real." }] }];
  }
}

// UNCHANGED since s01: loop until the model stops.
async function agentLoop(input: unknown[]): Promise<string> {
  for (;;) {
    const output = await callModel(input);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      let text = "";
      for (const item of output)
        for (const c of item.content ?? [])
          if (item.type === "message" && c.type === "output_text" && c.text) text += c.text;
      return text;
    }
    for (const call of calls) {
      const args = JSON.parse(call.arguments ?? "{}") as Json;
      console.log(`\x1b[33m⚙ ${call.name}\x1b[0m \x1b[2m${call.arguments}\x1b[0m`);
      const handler = REGISTRY.get(call.name ?? "");
      const result = handler ? await handler(args) : `Error: unknown tool "${call.name}"`;
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

async function main(): Promise<void> {
  console.log("s19: MCP tool bridge (Codex as a client)");
  console.log(OFFLINE ? "Offline demo — real MCP servers over stdio JSON-RPC. No connect_mcp tool.\n" : `Model: ${MODEL}.\n`);

  console.log("\x1b[2m# ~/.codex/config.toml — spawned at session start, before the loop:\x1b[0m");
  for (const [name, def] of Object.entries(MCP_CONFIG)) {
    console.log(`\x1b[2m[mcp_servers.${name}]\x1b[0m`);
    console.log(`\x1b[2mcommand = ${JSON.stringify(def.command)}\x1b[0m`);
    console.log(`\x1b[2margs = ${JSON.stringify(def.args)}\n\x1b[0m`);
  }

  const docs = await spawnMcp("docs");
  bridgeTools(docs);
  const deploy = await spawnMcp("deploy");
  bridgeTools(deploy);
  console.log(`\nTools exposed to the model: ${TOOLS.map((t) => t.name).join(", ")}\n`);

  const thread: unknown[] = [{ role: "user", content: "Find the agent-loop note, read it, then deploy staging." }];
  const answer = await agentLoop(thread);

  console.log(`\n\x1b[32m── final answer ──\x1b[0m\n${answer}`);
  docs.close();
  deploy.close();
}

const serveAt = process.argv.indexOf("--mcp-server");
if (serveAt >= 0) {
  runServer(process.argv[serveAt + 1]);
} else {
  main().catch((err) => { console.error("fatal:", err); process.exit(1); });
}
