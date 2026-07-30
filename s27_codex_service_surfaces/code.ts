#!/usr/bin/env tsx
/**
 * s27_codex_service_surfaces/code.ts — Codex as a Service: one engine, many frontends
 *
 * s21 showed the *CLI* has many doors into one harness. This chapter goes one level
 * down: the same engine also sits behind *process and network boundaries*. Real
 * Codex (v0.144.x) ships all of these frontends onto ONE engine + session store:
 *
 *   codex            (TUI)        in-process ────────────────┐
 *   codex app        (desktop)    app-server protocol        ┤
 *   VS Code extension             (stdio / unix / ws)        ├─▶ AppServer ─┐
 *   codex --remote ws://… (TUI)   app-server over websocket ─┘              ├─▶ ONE
 *   codex mcp-server (a tool)     MCP tools codex / codex-reply ─▶ McpServer ┘  CodexEngine
 *   ChatGPT Codex · @codex on GH  hosted cloud ────────────────▶ (same engine, s23)
 *
 * Verified against the real CLI: `codex mcp-server` exposes exactly two tools,
 * `codex` and `codex-reply`; the app-server v2 protocol (see
 * `codex app-server generate-json-schema`) centers on `thread/start` + `turn/start`.
 *
 * Run it (offline, no key needed — a scripted model drives the loop):
 *     npm install
 *     npx tsx s27_codex_service_surfaces/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s27_codex_service_surfaces/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const VERSION = "0.144.6";

type Effort = "low" | "medium" | "high";
type Approval = "untrusted" | "on-failure" | "on-request" | "never";
type Sandbox = "read-only" | "workspace-write" | "danger-full-access";

// ── The one engine: a session store + the s01 loop; frontends attach to it ───
interface ThreadConfig {
  model: string; effort: Effort; approval: Approval; sandbox: Sandbox; cwd: string;
}
interface Session extends ThreadConfig {
  id: string; thread: unknown[]; turns: number; // thread = Responses-API items
}

// Engine events use the `codex exec --json` stream names (s23): dot-separated.
type EngineEvent = { type: string; threadId: string; [k: string]: unknown };
type Listener = (ev: EngineEvent) => void;

const DEFAULTS = (cwd: string): ThreadConfig => ({
  model: process.env.MODEL_ID ?? "gpt-5-codex",
  effort: "medium", approval: "on-request", sandbox: "workspace-write", cwd,
});

class CodexEngine {
  private sessions = new Map<string, Session>();
  private listeners = new Set<Listener>();
  private seq = 0;

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(ev: EngineEvent): void {
    for (const l of this.listeners) l(ev);
  }
  threadCount(): number {
    return this.sessions.size;
  }
  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no such thread: ${id}`);
    return s;
  }
  newThread(cfg: Partial<ThreadConfig> = {}, cwd?: string): Session {
    const base = DEFAULTS(cwd ?? makeWorkspace());
    // Drop undefined keys so a sparse override never blanks out a default.
    const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined)) as Partial<ThreadConfig>;
    const s: Session = { ...base, ...clean, id: `thr_${(++this.seq).toString(36)}`, thread: [], turns: 0 };
    this.sessions.set(s.id, s);
    return s;
  }

  // The s01 loop, unchanged: call the model, run any tool calls, feed them back.
  async prompt(id: string, text: string): Promise<string> {
    const s = this.get(id);
    if (s.turns === 0) this.emit({ type: "thread.started", threadId: id, model: s.model, sandbox: s.sandbox });
    this.emit({ type: "turn.started", threadId: id });
    s.thread.push({ role: "user", content: text });
    let finalText = "";
    for (let step = 0; step < 8; step++) {
      const output = await callModel(s);
      s.thread.push(...output);
      const calls = output.filter((i) => i.type === "function_call");
      if (calls.length === 0) {
        for (const item of output)
          if (item.type === "message")
            for (const c of item.content ?? [])
              if (c.type === "output_text" && c.text) finalText += c.text;
        this.emit({ type: "item.completed", threadId: id, item: { type: "agent_message", text: finalText } });
        break;
      }
      for (const call of calls) {
        const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
        const result = runShell(s.cwd, command, s.sandbox);
        this.emit({ type: "item.completed", threadId: id, item: { type: "command_execution", command, output: result } });
        s.thread.push({ type: "function_call_output", call_id: call.call_id, output: result });
      }
    }
    s.turns++;
    this.emit({ type: "turn.completed", threadId: id, usage: { tokens: Math.ceil(JSON.stringify(s.thread).length / 4) } });
    return finalText;
  }
}

// ── The one tool (a shell), gated by the thread's sandbox mode ───────────────
const TOOLS = [
  {
    type: "function" as const,
    name: "shell",
    description: "Run a shell command in the workspace and return stdout+stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function runShell(cwd: string, command: string, sandbox: Sandbox): string {
  if (sandbox === "read-only" && />>?|\brm\b|\bmv\b|\bcp\b|\bmkdir\b/.test(command))
    return `Error: sandbox=read-only refuses a write command: ${command}`;
  try {
    const out = execSync(command, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 });
    return (String(out).trim() || "(no output)").slice(0, 8_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

// ── Model adapter: real Responses API, or a scripted offline stand-in ────────
type OutputItem = {
  type: string; id?: string; call_id?: string; name?: string;
  arguments?: string; content?: { type: string; text?: string }[];
};

const openai = OFFLINE ? null : new OpenAI();

async function callModel(s: Session): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: s.model,
      instructions: `You are Codex, a coding agent in ${s.cwd}. Use the shell tool. Act, don't explain.`,
      input: s.thread as never,
      tools: TOOLS,
      reasoning: { effort: s.effort },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(s);
}

// Offline stand-in: one shell call, then an answer that *cites the thread's own
// config and length* — so you can watch each door's settings reach the engine,
// and watch a reply continue the very same thread.
function offlineModel(s: Session): OutputItem[] {
  const ran = s.thread.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (ran === 0)
    return [
      { type: "function_call", id: "c1", call_id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls && echo '---' && head -5 README.md" }) },
    ];
  const text =
    `[offline demo] thread=${s.id} · turn ${s.turns + 1} · ran on model=${s.model}, ` +
    `sandbox=${s.sandbox}, approval=${s.approval}. This conversation now holds ${s.thread.length + 1} items — ` +
    `whichever door you came through, it is the same engine and the same thread.`;
  return [{ type: "message", content: [{ type: "output_text", text }] }];
}

// ── NEW in s27: Door 1 — the CLI / TUI, attached in-process ─────────────────
// The TUI talks to the engine directly (no wire) and renders events as narration.
function attachCli(engine: CodexEngine): { run: (task: string, cfg?: Partial<ThreadConfig>) => Promise<string> } {
  return {
    async run(task, cfg = {}) {
      const s = engine.newThread(cfg);
      const off = engine.on((ev) => {
        if (ev.threadId !== s.id) return;
        const item = ev.item as { type?: string; command?: string; text?: string; output?: string } | undefined;
        if (ev.type === "item.completed" && item?.type === "command_execution") {
          console.log(`  \x1b[33m$ ${item.command}\x1b[0m`);
          console.log(`  ${String(item.output).split("\n").slice(0, 4).join("\n  ")}`);
        }
        if (ev.type === "item.completed" && item?.type === "agent_message") console.log(`  ${item.text}`);
      });
      try {
        console.log(`  (thread ${s.id} opened)`);
        return await engine.prompt(s.id, task);
      } finally {
        off();
      }
    },
  };
}

// ── NEW in s27: Door 2 — the app-server: JSON-RPC over stdio/unix/ws ────────
// `codex app-server --listen ws://…` serves it; `codex --remote ws://…`, the
// desktop app and the VS Code extension are clients of this one protocol. Real
// v2 method names (from `codex app-server generate-json-schema`): thread/start
// opens a thread, turn/start drives one turn; progress streams back as
// */started and item/completed notifications. (The real turn/start acks at once
// and streams deltas; for clarity our teaching model awaits the finished turn.)
class AppServer {
  constructor(private engine: CodexEngine) {}

  connect(notify: (method: string, params: unknown) => void): {
    close: () => void;
    request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  } {
    // Engine events (exec-style dots) → app-server notifications (v2 slashes).
    const close = this.engine.on((ev) => notify(ev.type.replace(".", "/"), ev));
    return { close, request: (m, p = {}) => this.dispatch(m, p) };
  }

  private async dispatch(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": // v1 initialize → userAgent, codexHome, platform…
        return { userAgent: `codex_cli_rs/${VERSION}`, codexHome: "~/.codex" };
      case "thread/start": { // → { thread: { id }, model, cwd, sandbox, … }
        const s = this.engine.newThread((p.config as Partial<ThreadConfig>) ?? {}, p.cwd as string | undefined);
        return { thread: { id: s.id }, model: s.model, cwd: s.cwd, sandbox: s.sandbox };
      }
      case "turn/start": // { threadId, input, … } — continue that thread with a turn
        return this.engine.prompt(String(p.threadId), String(p.input));
      default:
        throw new Error(`unknown method ${method}`);
    }
  }
}

// ── NEW in s27: Door 3 — Codex AS an MCP server (`codex mcp-server`) ────────
// Verified against the real CLI: server `codex-mcp-server` exposes exactly two
// tools. Here the engine is the *callee*, not the driver — any MCP client calls it.
class McpServer {
  constructor(private engine: CodexEngine) {}

  toolsList(): { name: string; description: string }[] {
    return [
      { name: "codex", description: "Run a Codex session. Accepts configuration parameters matching the Codex Config struct." },
      { name: "codex-reply", description: "Continue a Codex conversation by providing the thread id and prompt." },
    ];
  }

  async toolsCall(name: string, args: Record<string, unknown>): Promise<{ threadId: string; text: string }> {
    if (name === "codex") {
      // Real input keys: prompt, model, cwd, sandbox, approval-policy, config, …
      const cfg: Partial<ThreadConfig> = {
        model: (args.model as string) ?? undefined,
        sandbox: (args.sandbox as Sandbox) ?? undefined,
        approval: (args["approval-policy"] as Approval) ?? undefined,
        ...((args.config as Partial<ThreadConfig> | undefined) ?? {}),
      };
      const s = this.engine.newThread(cfg, args.cwd as string | undefined);
      const text = await this.engine.prompt(s.id, String(args.prompt));
      return { threadId: s.id, text };
    }
    if (name === "codex-reply") {
      const id = String(args.threadId ?? args.conversationId);
      const text = await this.engine.prompt(id, String(args.prompt));
      return { threadId: id, text };
    }
    throw new Error(`unknown tool ${name}`);
  }
}

// A scratch workspace so the demo has real files to inspect, isolated from yours.
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-s27-"));
  writeFileSync(join(dir, "README.md"), "# demo workspace\n\nOne engine, many frontends.\n");
  writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
  return dir;
}

// ── Entry point: ONE engine, driven through three different doors ────────────
async function main(): Promise<void> {
  console.log("s27: Codex as a Service — one engine, many frontends");
  console.log(OFFLINE ? "Offline demo model. The SAME task enters through three doors:\n" : "Real model. Three doors:\n");

  const engine = new CodexEngine(); // ← the single shared engine + session store

  // Door 1: the CLI / TUI, in-process.
  console.log("\x1b[36m── Door 1 · codex (TUI / CLI, in-process) ──\x1b[0m");
  const cli = attachCli(engine);
  await cli.run("inspect this workspace and tell me what is here");
  const cliThread = "thr_1"; // the thread Door 1 just opened

  // Door 2: a remote TUI / desktop app / IDE over the app-server protocol.
  console.log("\n\x1b[36m── Door 2 · codex app-server + codex --remote ws://… ──\x1b[0m");
  const app = new AppServer(engine).connect((method, params) => {
    const ev = params as EngineEvent;
    const item = ev.item as { type?: string; text?: string } | undefined;
    if (method === "item/completed" && item?.type === "agent_message") console.log(`  [notify ${method}] ${item.text}`);
  });
  console.log("  → initialize:", JSON.stringify(await app.request("initialize")));
  const started = (await app.request("thread/start", { config: { sandbox: "read-only" } })) as { thread: { id: string } };
  console.log(`  → thread/start → ${started.thread.id} (config: sandbox=read-only)`);
  await app.request("turn/start", { threadId: started.thread.id, input: "list the files here" });
  app.close();

  // Door 3: Codex exposed AS an MCP tool to an external client.
  console.log("\n\x1b[36m── Door 3 · codex mcp-server (engine as an MCP tool) ──\x1b[0m");
  const mcp = new McpServer(engine);
  console.log("  → tools/list:", mcp.toolsList().map((t) => t.name).join(", "));
  const r1 = await mcp.toolsCall("codex", { prompt: "what is in this workspace?", sandbox: "read-only", "approval-policy": "never" });
  console.log(`  → tools/call codex → ${r1.threadId}\n  ${r1.text}`);
  // The punchline: continue the thread Door 1 opened — proving one shared engine.
  const r2 = await mcp.toolsCall("codex-reply", { threadId: cliThread, prompt: "and what changed since?" });
  console.log(`  → tools/call codex-reply(${r2.threadId}, a thread Door 1 opened) →\n  ${r2.text}`);

  console.log(`\n\x1b[36m── ${engine.threadCount()} threads across 3 frontends, 1 CodexEngine ──\x1b[0m`);
  console.log("CLI, app-server (desktop/IDE/remote TUI) and mcp-server all drove the same loop and session store.");
}

main();
