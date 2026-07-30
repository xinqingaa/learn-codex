#!/usr/bin/env tsx
/**
 * s21_codex_cli/code.ts — The Codex CLI Surface (one binary, many doors)
 *
 * Everything so far was ONE loop. The real Codex ships that loop behind a single
 * `codex` binary with many entrances, all funneling into the same harness:
 *
 *     argv subcommands                    in-session slash commands
 *     ────────────────                    ─────────────────────────
 *     codex              (TUI, default)   /model      switch model + reasoning effort
 *     codex exec  ".."   (non-interactive)/approvals  set approval_policy
 *     codex resume --last                 /compact    summarize the thread
 *     codex review --base main            /status     session + token usage
 *     codex login --device-auth           /diff       show the working-tree diff
 *     codex mcp  list                     /init       scaffold AGENTS.md
 *          \______________ ______________/   (+ /new /mcp /help /quit)
 *                        \/
 *                 ONE DISPATCH LAYER → the same agent loop + tools + config
 *
 * This chapter builds that dispatch layer: parse argv subcommands and `/`-prefixed
 * slash commands, route each to a harness function. The s01 loop never changes —
 * dispatch only decides *which door you came in through*.
 *
 * Run it (offline, no key needed — a scripted model drives the loop):
 *     npm install
 *     npx tsx s21_codex_cli/code.ts                    # narrated TUI-session demo
 *     npx tsx s21_codex_cli/code.ts exec "fix the bug" # one non-interactive run
 *     npx tsx s21_codex_cli/code.ts login              # routed subcommand
 *     OPENAI_API_KEY=sk-... npx tsx s21_codex_cli/code.ts exec "..."   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

type Effort = "low" | "medium" | "high";
type Approval = "untrusted" | "on-failure" | "on-request" | "never";

// ── Session: the one mutable state every door shares ─────────────────────────
interface Session {
  model: string;
  effort: Effort;
  approval: Approval;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  workspace: string; // the cwd the agent acts on
  thread: unknown[]; // Responses-API items accumulated this session
  mcpServers: string[]; // configured ~/.codex MCP servers (names only here)
}

const newSession = (workspace: string): Session => ({
  model: process.env.MODEL_ID ?? "gpt-5-codex",
  effort: "medium",
  approval: "on-request",
  sandbox: "workspace-write",
  workspace,
  thread: [],
  mcpServers: [],
});

// A rough token estimate so /status and /compact have something to report.
const approxTokens = (s: Session) => Math.ceil(JSON.stringify(s.thread).length / 4);

// ── The one tool (a shell), unchanged in spirit since s01 ────────────────────
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

function runShell(s: Session, command: string): string {
  try {
    const out = execSync(command, { cwd: s.workspace, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return (String(out).trim() || "(no output)").slice(0, 20_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

// ── Model adapter: real Responses API, or a scripted offline stand-in ────────
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

const openai = OFFLINE ? null : new OpenAI();

async function callModel(s: Session): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: s.model, // whatever /model (or -c model=) set
      instructions: `You are Codex, a coding agent in ${s.workspace}. Use the shell tool. Act, don't explain.`,
      input: s.thread as never,
      tools: TOOLS,
      reasoning: { effort: s.effort }, // whatever /model set
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(s);
}

// Offline stand-in: one shell call, then an answer that *cites the session's
// current model/effort* so you can watch /model take effect on the next turn.
function offlineModel(s: Session): OutputItem[] {
  const ran = s.thread.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (ran === 0) {
    return [
      { type: "function_call", id: "c1", call_id: "c1", name: "shell", arguments: JSON.stringify({ command: "git diff --stat && echo '---' && ls" }) },
    ];
  }
  const text =
    `[offline demo] Done — one shell call inspected the workspace. This turn ran on ` +
    `model=${s.model} at effort=${s.effort} (approval=${s.approval}, sandbox=${s.sandbox}). ` +
    `Set OPENAI_API_KEY for a real model; the dispatch layer is identical.`;
  return [{ type: "message", content: [{ type: "output_text", text }] }];
}

// ── The core loop, unchanged: keep calling tools until the model stops ──────
async function agentLoop(s: Session): Promise<void> {
  for (;;) {
    const output = await callModel(s);
    s.thread.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        if (item.type === "message")
          for (const c of item.content ?? []) if (c.type === "output_text" && c.text) console.log(c.text);
      return;
    }
    for (const call of calls) {
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      console.log(`\x1b[33m$ ${command}\x1b[0m`);
      const result = runShell(s, command);
      console.log(result.split("\n").slice(0, 8).join("\n"));
      s.thread.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── NEW in s21: the slash-command dispatch table ─────────────────────────────
// Each handler mutates the shared Session (or the harness) and prints a result.
// In the real TUI these are rows in a popup; here they are entries in one map.
type Handler = (s: Session, args: string[]) => void | Promise<void>;

const SLASH: Record<string, { desc: string; run: Handler }> = {
  "/model": {
    desc: "choose the active model and reasoning effort",
    run: (s, [m, e]) => {
      if (m) s.model = m;
      if (e && ["low", "medium", "high"].includes(e)) s.effort = e as Effort;
      console.log(`model → ${s.model}   reasoning effort → ${s.effort}`);
    },
  },
  "/approvals": {
    // Current Codex spells this /permissions; the older name still routes here.
    desc: "set what Codex may do without asking first (approval_policy)",
    run: (s, [p]) => {
      if (p && ["untrusted", "on-failure", "on-request", "never"].includes(p)) s.approval = p as Approval;
      console.log(`approval_policy → ${s.approval}`);
    },
  },
  "/compact": {
    desc: "summarize the conversation to free context tokens",
    run: (s) => {
      const before = approxTokens(s);
      s.thread = [{ role: "user", content: `[summary of ${s.thread.length} earlier items]` }];
      console.log(`compacted: ~${before} → ~${approxTokens(s)} tokens`);
    },
  },
  "/status": {
    desc: "show the current session configuration and token usage",
    run: (s) =>
      console.log(
        `model=${s.model}  effort=${s.effort}\napproval=${s.approval}  sandbox=${s.sandbox}\n` +
          `cwd=${s.workspace}\nthread=${s.thread.length} items  ~${approxTokens(s)} tokens`
      ),
  },
  "/diff": {
    desc: "show the git diff (including untracked files)",
    run: (s) => console.log(runShell(s, "git add -N . 2>/dev/null; git --no-pager diff 2>/dev/null || git status --short")),
  },
  "/new": {
    desc: "start a fresh chat (clear the thread)",
    run: (s) => {
      s.thread = [];
      console.log("new session — thread cleared");
    },
  },
  "/init": {
    desc: "write an AGENTS.md scaffold into the workspace",
    run: (s) => {
      writeFileSync(join(s.workspace, "AGENTS.md"), "# AGENTS.md\n\n- Project instructions for Codex.\n");
      console.log(`wrote ${join(s.workspace, "AGENTS.md")}`);
    },
  },
  "/mcp": { desc: "list configured MCP servers", run: (s) => console.log(s.mcpServers.join("\n") || "(no MCP servers configured)") },
  "/help": {
    // The real TUI lists these in the `/` popup; our dispatch table prints them.
    desc: "list the available commands",
    run: () => Object.entries(SLASH).forEach(([n, c]) => console.log(`  ${n.padEnd(12)} ${c.desc}`)),
  },
};
SLASH["/permissions"] = SLASH["/approvals"]; // current name, same handler
SLASH["/quit"] = SLASH["/exit"] = { desc: "exit Codex", run: () => console.log("bye") };

// ── NEW in s21: one in-session dispatch entry point ──────────────────────────
// `/...` routes to the table; anything else is a prompt for the loop.
async function dispatch(s: Session, line: string): Promise<void> {
  if (line.startsWith("/")) {
    const [name, ...args] = line.split(/\s+/);
    const cmd = SLASH[name];
    return cmd ? cmd.run(s, args) : console.log(`unknown command ${name} — try /help`);
  }
  s.thread.push({ role: "user", content: line });
  return agentLoop(s);
}

// ── NEW in s21: argv subcommands — the doors into the same harness ──────────
async function routeArgv(argv: string[]): Promise<boolean> {
  const [sub, ...rest] = argv;
  const s = newSession(makeWorkspace());
  switch (sub) {
    case "exec": // codex exec "..." — non-interactive, print and exit
      console.log(`[codex exec] non-interactive run in ${s.workspace}`);
      await dispatch(s, rest.join(" ") || "look at the workspace");
      return true;
    case "review": // codex review — a review prompt through the same loop
      console.log("[codex review] non-interactive code review");
      await dispatch(s, "review the current changes and find issues");
      return true;
    case "resume": // codex resume --last — reload a rollout and continue (s09)
      console.log(`[codex resume] reload a saved session (${rest.join(" ") || "picker"}) and continue`);
      return true;
    case "login": // codex login [--device-auth|--with-api-key] / Sign in with ChatGPT
      console.log(`[codex login] ${rest.includes("--device-auth") ? "device-code (headless)" : "ChatGPT browser or --with-api-key"}`);
      return true;
    case "logout":
      console.log("[codex logout] remove stored credentials");
      return true;
    case "mcp": // codex mcp list|add|... — manage MCP servers (s19)
      console.log(`[codex mcp ${rest[0] ?? "list"}] manage MCP servers`);
      return true;
    default:
      return false; // no known subcommand → fall through to the TUI demo
  }
}

// A scratch git repo so the demo has a real diff to show, isolated from yours.
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-s21-"));
  const sh = (c: string) => execSync(c, { cwd: dir, stdio: "ignore" });
  sh("git init -q");
  writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
  sh("git add -A && git -c user.email=d@d -c user.name=d commit -qm init");
  writeFileSync(join(dir, "app.ts"), "export const x = 2;\n"); // a tracked modification for /diff
  return dir;
}

// ── Entry point: a self-running, narrated TUI session (or one subcommand) ────
async function main(): Promise<void> {
  if (await routeArgv(process.argv.slice(2))) return;

  const s = newSession(makeWorkspace());
  console.log("s21: The Codex CLI Surface — one dispatch layer over the harness");
  console.log(OFFLINE ? "Offline demo model. A scripted session drives every door:\n" : "Real model. Scripted session:\n");

  // The exact lines a user would type; each goes through the same dispatch().
  const script = [
    "/status",
    "/model gpt-5-codex high",
    "/approvals never",
    "/diff",
    "/init",
    "inspect the workspace and tell me what changed",
    "/status",
    "/compact",
    "/mcp",
    "/quit",
  ];
  for (const line of script) {
    console.log(`\x1b[36mcodex> ${line}\x1b[0m`);
    await dispatch(s, line);
    console.log();
  }
}

main();
