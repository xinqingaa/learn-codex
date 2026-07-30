#!/usr/bin/env tsx
/**
 * s24_plugins_apps_hooks/code.ts — Plugins, Apps & Hooks (Codex-style, in TypeScript)
 *
 * Skills (s07) and MCP servers (s19) extend the agent one piece at a time. The real
 * Codex adds three more surfaces on top of the same loop:
 *
 *     PLUGINS (codex plugin add|list|marketplace|remove)
 *       one installable bundle = skills + hooks + MCP servers, shipped as a
 *       marketplace snapshot and installed in a single step.
 *     APPS (the `apps` feature flag, stable)
 *       packaged app/connectors whose MCP tools the model can trigger.
 *     HOOKS (the `hooks` feature flag, stable)
 *       lifecycle commands the harness runs on events — SessionStart,
 *       UserPromptSubmit, PreToolUse (can BLOCK), PostToolUse, Stop, ...
 *     `codex mcp-server` turns Codex ITSELF into an MCP server over stdio.
 *
 *     marketplace snapshot            install               agent loop (s01, same)
 *     ┌──────────────────┐  plugin add  ┌───────────┐   SessionStart▶┌──────────┐
 *     │ plugin.json      │ ───────────▶ │ registry  │ ──────────────▶│  model   │
 *     │  skills▪ hooks   │              │ skills    │                └────┬─────┘
 *     │  mcpServers▪apps │              │ hooks     │   PreToolUse ─block?│─▶ tool
 *     └──────────────────┘              │ mcpServers│   PostToolUse ◀─────┘
 *                                       └───────────┘   Stop (turn done)
 *
 * The loop never changes. A plugin just *registers* capabilities; hooks just *fire*
 * around it. This demo installs one plugin (registering a skill, two hooks, an MCP
 * server), then runs the s01 loop so you can watch every hook fire — including a
 * PreToolUse guard that BLOCKS a dangerous command before it ever runs.
 *
 * Run it (offline, no key needed — a scripted model drives the loop):
 *     npm install
 *     npx tsx s24_plugins_apps_hooks/code.ts        # narrated plugin + hook trace
 *     OPENAI_API_KEY=sk-... npx tsx s24_plugins_apps_hooks/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";

const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const openai = OFFLINE ? null : new OpenAI();
const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";

// Narration goes to stderr so the trace stays readable; nothing here needs stdout.
const t0 = Date.now();
function say(actor: string, msg: string): void {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  console.error(`\x1b[2m${t}s\x1b[0m \x1b[36m${actor.padEnd(9)}\x1b[0m ${msg}`);
}

// ── NEW in s24: hook events & the hook model ─────────────────────────────────
// Real Codex hooks are external commands (from hooks.json / a plugin) that the
// harness runs on lifecycle events, feeding a JSON payload and reading a decision.
// PreToolUse may BLOCK the call ("Tool call blocked by PreToolUse hook"); a
// SessionStart hook may inject extra context. We model each as a small handler.
type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

interface HookPayload {
  event: HookEvent;
  tool?: string; // PreToolUse / PostToolUse
  input?: string; // the tool call's input (e.g. the shell command)
  output?: string; // PostToolUse: the tool's result
  prompt?: string; // UserPromptSubmit
}
interface HookDecision {
  block?: boolean; // PreToolUse: stop the tool call before it runs
  reason?: string; // why it blocked
  context?: string; // SessionStart: extra context to prepend to the turn
}
interface Hook {
  event: HookEvent;
  name: string;
  command: string; // the real-world shell command this hook stands in for
  run: (p: HookPayload) => HookDecision | void;
}

// ── NEW in s24: a plugin manifest = a bundle of capabilities ─────────────────
// Mirrors plugin.json: one installable unit carrying skills, hooks, MCP servers.
interface Skill { name: string; summary: string }
interface PluginManifest {
  name: string; // e.g. "devtools"
  marketplace: string; // e.g. "local"  → installed as devtools@local
  skills: Skill[];
  hooks: Hook[];
  mcpServers: string[];
}

// ── NEW in s24: the registry — what `codex plugin add` populates ─────────────
// The harness keeps ONE registry of capabilities; installing a plugin merges the
// bundle's skills/hooks/MCP servers into it (real Codex: "supplemented on top of
// default component discovery; they do not replace defaults").
class Registry {
  plugins: PluginManifest[] = [];
  skills = new Map<string, Skill>();
  hooks: Hook[] = [];
  mcpServers: string[] = [];

  installPlugin(m: PluginManifest): void {
    this.plugins.push(m);
    for (const s of m.skills) this.skills.set(s.name, s);
    this.hooks.push(...m.hooks);
    this.mcpServers.push(...m.mcpServers);
    say("plugin", `installed \x1b[1m${m.name}@${m.marketplace}\x1b[0m → ` +
      `${m.skills.length} skill(s), ${m.hooks.length} hook(s), ${m.mcpServers.length} MCP server(s)`);
  }
  removePlugin(name: string): void {
    const i = this.plugins.findIndex((p) => p.name === name);
    if (i < 0) return;
    const [m] = this.plugins.splice(i, 1);
    for (const s of m.skills) this.skills.delete(s.name);
    this.hooks = this.hooks.filter((h) => !m.hooks.includes(h));
    this.mcpServers = this.mcpServers.filter((x) => !m.mcpServers.includes(x));
    say("plugin", `removed ${name} — its skills/hooks/MCP servers left the registry`);
  }

  // Fire every hook registered for an event, in order; collect their decisions.
  fire(event: HookEvent, payload: Omit<HookPayload, "event">): HookDecision[] {
    const out: HookDecision[] = [];
    for (const h of this.hooks.filter((x) => x.event === event)) {
      say("hook", `\x1b[35m${event}\x1b[0m ← ${h.name}  \x1b[2m$ ${h.command}\x1b[0m`);
      const d = h.run({ ...payload, event });
      if (d) out.push(d);
      if (d?.block) say("hook", `\x1b[31mBLOCKED\x1b[0m by ${h.name}: ${d.reason}`);
      if (d?.context) say("hook", `injected context: ${d.context}`);
    }
    return out;
  }
}

// ── A marketplace snapshot: one plugin that bundles a skill + hooks + MCP ────
// `codex plugin marketplace add <src>` then `codex plugin add devtools@local`.
const DEVTOOLS: PluginManifest = {
  name: "devtools",
  marketplace: "local",
  skills: [{ name: "repo-hygiene", summary: "keep the working tree clean; never force-delete build output blindly" }],
  hooks: [
    {
      event: "SessionStart",
      name: "inject-repo-rules",
      command: "cat .agents/policy.md", // real hook: print extra context on session start
      run: () => ({ context: "repo policy: confirm before any destructive delete" }),
    },
    {
      event: "PreToolUse",
      name: "guard-rm",
      command: "./hooks/guard.sh", // real hook: a script that vetoes dangerous commands
      run: (p) =>
        p.input?.includes("rm -rf")
          ? { block: true, reason: "destructive `rm -rf` needs human approval (repo policy)" }
          : {},
    },
    {
      event: "PostToolUse",
      name: "audit-log",
      command: "./hooks/audit.sh >> .codex/audit.log", // real hook: record what ran
      run: (p) => void say("hook", `audit: ran \`${p.input}\` → ${(p.output ?? "").split("\n")[0]?.slice(0, 48)}`),
    },
    { event: "Stop", name: "on-finish", command: "./hooks/notify.sh", run: () => void say("hook", "turn complete — notify/telemetry would run here") },
  ],
  mcpServers: ["linear"],
};

// ── The one tool (a shell), unchanged since s01 ──────────────────────────────
const TOOLS = [
  {
    type: "function" as const,
    name: "shell",
    description: "Run a shell command and return stdout+stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
];
function runShell(command: string): string {
  try {
    const out = execSync(command, { timeout: 30_000 });
    return (String(out).trim() || "(no output)").slice(0, 4_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

// ── Model adapter: real Responses API, or a scripted offline stand-in ────────
type OutputItem = { type: string; id?: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] };
const fnCall = (id: string, command: string): OutputItem => ({ type: "function_call", id, call_id: id, name: "shell", arguments: JSON.stringify({ command }) });

async function callModel(thread: unknown[]): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions: "You are Codex, a coding agent. Use the shell tool. Tidy the workspace, then report.",
      input: thread as never,
      tools: TOOLS,
    });
    return resp.output as unknown as OutputItem[];
  }
  // Offline: first try a destructive command (the PreToolUse hook blocks it),
  // then a safe one, then finish — so every hook fires in one short run.
  const ran = thread.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (ran === 0) return [fnCall("c1", "rm -rf ./dist && echo cleaned")]; // → blocked by guard-rm
  if (ran === 1) return [fnCall("c2", "ls -1")]; // → allowed; PostToolUse audits it
  const text =
    "[offline demo] Done. The destructive `rm -rf` was blocked by the plugin's PreToolUse " +
    "hook before it ran; the safe `ls` ran and was audited by PostToolUse. Same loop as " +
    "s01 — the plugin only registered capabilities and hooks around it. Set OPENAI_API_KEY for a real model.";
  return [{ type: "message", content: [{ type: "output_text", text }] }];
}

// ── The s01 loop, now with hooks fired around it (loop body itself unchanged) ─
async function agentLoop(reg: Registry, prompt: string): Promise<void> {
  // SessionStart hooks may inject context; UserPromptSubmit hooks see the prompt.
  const ctx = reg.fire("SessionStart", {}).map((d) => d.context).filter(Boolean).join("; ");
  reg.fire("UserPromptSubmit", { prompt });
  const thread: unknown[] = [{ role: "user", content: (ctx ? `[context] ${ctx}\n\n` : "") + prompt }];

  for (;;) {
    const output = await callModel(thread);
    thread.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        if (item.type === "message")
          for (const c of item.content ?? []) if (c.type === "output_text" && c.text) say("agent", c.text);
      reg.fire("Stop", {}); // turn finished
      return;
    }
    for (const call of calls) {
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      // PreToolUse: any hook decision with block:true stops the call BEFORE it runs.
      const blocked = reg.fire("PreToolUse", { tool: "shell", input: command }).find((d) => d.block);
      const result = blocked ? `Tool call blocked by PreToolUse hook: ${blocked.reason}` : runShell(command);
      if (!blocked) reg.fire("PostToolUse", { tool: "shell", input: command, output: result });
      say("tool", `\x1b[33m$ ${command}\x1b[0m → ${result.split("\n")[0]?.slice(0, 60)}`);
      thread.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Self-running narrated demo ────────────────────────────────────────────────
async function main(): Promise<void> {
  say("s24", "Plugins, Apps & Hooks (Codex-style)");
  say("s24", OFFLINE ? "offline demo model — a scripted two-call run" : `model: ${MODEL}`);

  const reg = new Registry();
  say("market", "codex plugin marketplace add ./local   (register a marketplace source)");
  reg.installPlugin(DEVTOOLS); // codex plugin add devtools@local
  say("plugin", `registry now: skills=[${[...reg.skills.keys()]}] hooks=${reg.hooks.length} mcp=[${reg.mcpServers}]`);
  say("apps", "(the stable `apps` flag surfaces packaged app/connectors; their MCP tools");
  say("apps", " trigger via [$app](app://id) — another bundle, not modeled in this loop)");

  say("loop", "── running the s01 agent loop with the plugin's hooks armed ──");
  await agentLoop(reg, "clean up the build output, then list what's left");
  say("loop", "── loop finished ──");

  say("mcp-srv", "flip it around: `codex mcp-server` runs Codex ITSELF as an MCP server");
  say("mcp-srv", "  over stdio, so another agent/MCP client can call Codex as a tool.");
  reg.removePlugin("devtools"); // codex plugin remove devtools@local
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
