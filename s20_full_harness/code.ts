#!/usr/bin/env tsx
/**
 * s20_full_harness/code.ts — The Full Harness (Codex-style, in TypeScript)
 *
 * Every chapter added ONE mechanism to the loop. This capstone wires them all
 * into a single agent — and the point is that the loop at the center is still
 * the exact `for (;;)` from s01. Everything else is a *layer* around it:
 *
 *        user task
 *           │
 *   ┌───────▼────────────────────────────────────────┐
 *   │  memory layer    (rollout: persist every turn) │  s09
 *   │  ┌──────────────────────────────────────────┐  │
 *   │  │            s01 AGENT LOOP                │  │
 *   │  │   model → function_call? → run → feed    │  │
 *   │  └───────┬───────────────────────▲──────────┘  │
 *   │          │ tool call             │ output      │
 *   │  ┌───────▼───────────────────────┴──────────┐  │
 *   │  │  sandbox layer   (where may it write?)   │  │  s04
 *   │  │  approval layer  (may it run at all?)    │  │  s03
 *   │  │  tool registry   (shell/write/plan/...)  │  │  s02
 *   │  │  ├ update_plan    (live checklist)       │  │  s05
 *   │  │  ├ spawn_subagent (fresh child loop)     │  │  s06
 *   │  │  └ mcp__* tools   (bridged MCP server)   │  │  s19
 *   │  └──────────────────────────────────────────┘  │
 *   └────────────────────────────────────────────────┘
 *
 * Some mechanisms are *tools in the registry* (plan, subagent, MCP), some are
 * *layers around dispatch* (sandbox, approval), and memory is a *layer around
 * the model call*. They all surround the same loop — they never change it.
 *
 * Run it (self-running narrated demo, no input needed):
 *     npm install
 *     npx tsx s20_full_harness/code.ts          # offline scripted model
 *     OPENAI_API_KEY=sk-... npx tsx s20_full_harness/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

// An isolated workspace so the demo can write files without touching the repo.
// sandbox_mode = "workspace-write": reads anywhere, writes only under WORKSPACE.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "codex-s20-"));
const ROLLOUT = path.join(WORKSPACE, "rollout.jsonl"); // s09 session rollout

// ── Narrated trace ──────────────────────────────────────────────────────────
// The whole point of this chapter is to *see* which layer fires when.
const C = { d: "\x1b[90m", b: "\x1b[34m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", m: "\x1b[35m", c: "\x1b[36m", x: "\x1b[0m" };
function say(layer: string, color: string, msg: string): void {
  console.log(`  ${color}[${layer}]${C.x} ${msg}`);
}

// ── Responses API shapes ────────────────────────────────────────────────────
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};
type FnTool = { type: "function"; name: string; description: string; parameters: Record<string, unknown>; strict: boolean };
// Tool args arrive as JSON-parsed objects of varying shape, so `any` is used per-handler.
type Handler = (args: Record<string, any>) => Promise<string> | string;

// ── s02 · Tool registry ─────────────────────────────────────────────────────
// One dispatch map. Tools are added here; the loop just looks them up by name.
const TOOLS: FnTool[] = [];
const REGISTRY = new Map<string, Handler>();
function register(tool: FnTool, handler: Handler): void {
  TOOLS.push(tool);
  REGISTRY.set(tool.name, handler);
}
const fn = (name: string, description: string, parameters: Record<string, unknown>): FnTool =>
  ({ type: "function", name, description, parameters, strict: true });
const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> =>
  ({ type: "object", properties, required, additionalProperties: false });

// ── s05 · update_plan: a live checklist the model maintains ────────────────
register(
  fn("update_plan", "Record or update the step-by-step plan for the task.",
    obj({ plan: { type: "array", items: obj({ step: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, ["step", "status"]) } }, ["plan"])),
  (args) => {
    const plan = args.plan as { step: string; status: string }[];
    for (const p of plan) {
      const mark = p.status === "completed" ? "✓" : p.status === "in_progress" ? "▶" : "·";
      say("plan", C.m, `${mark} ${p.step} ${C.d}(${p.status})${C.x}`);
    }
    return `plan recorded: ${plan.length} steps`;
  }
);

// ── s02 · real tools: shell + write_file ────────────────────────────────────
register(
  fn("shell", "Run a shell command and return its combined stdout+stderr.",
    obj({ command: { type: "string" } }, ["command"])),
  (args) => {
    try {
      const out = execSync(args.command, { cwd: WORKSPACE, timeout: 60_000, maxBuffer: 1024 * 1024 });
      return (String(out).trim() || "(no output)").slice(0, 20_000);
    } catch (err) {
      const e = err as { stderr?: Buffer; message?: string };
      return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
    }
  }
);
register(
  fn("write_file", "Write text to a file at an absolute or workspace-relative path.",
    obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"])),
  (args) => {
    const abs = path.resolve(WORKSPACE, args.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content);
    return `wrote ${abs} (${args.content.length} bytes)`;
  }
);

// ── s06 · spawn_subagent: delegate to a child loop with a FRESH context ────
// The child runs the very same agentLoop below, but on its own thread array.
// Only its final summary returns to the parent — the parent's context stays clean.
async function runSubagent(task: string): Promise<string> {
  say("subagent", C.c, `spawning child loop for: ${C.d}"${task}"${C.x}`);
  const childThread: unknown[] = [{ role: "user", content: task }];
  const text = await agentLoop(childThread, /*isChild=*/true);
  say("subagent", C.c, `child finished → ${C.d}${text.slice(0, 80)}${C.x}`);
  return text;
}
register(
  fn("spawn_subagent", "Delegate a self-contained subtask to a sub-agent and get its summary back.",
    obj({ task: { type: "string" } }, ["task"])),
  (args) => runSubagent(args.task)
);

// ── s19 · MCP bridge: connect to an MCP server, expose its tools ───────────
// Real Codex spawns `mcp_servers` over stdio JSON-RPC, lists tools, and names
// them mcp__<server>__<tool>. Here the "server" is an in-process mock so the
// demo runs offline; the bridge + naming + dispatch are the real pattern.
const MCP_SERVERS: Record<string, { tools: FnTool[]; call(tool: string, args: Record<string, any>): string }> = {
  docs: {
    tools: [fn("search", "Search the local Codex course notes.", obj({ query: { type: "string" } }, ["query"]))],
    call: (_tool, args) =>
      `[docs] top hit for "${args.query}": "The agent loop (s01) — while the model keeps ` +
      `calling tools, run them and feed each result back; stop when it stops."`,
  },
};
function connectMcp(server: string): void {
  const s = MCP_SERVERS[server];
  for (const t of s.tools) {
    const bridged = fn(`mcp__${server}__${t.name}`, `(MCP:${server}) ${t.description}`, t.parameters);
    register(bridged, (args) => {
      say("mcp", C.b, `${server}.${t.name}(${JSON.stringify(args)}) via bridge`);
      return s.call(t.name, args);
    });
  }
  say("mcp", C.b, `connected to MCP server "${server}" → exposed ${s.tools.length} tool(s)`);
}

// ── s04 · sandbox layer (workspace-write) ───────────────────────────────────
type Dispatch = (name: string, args: Record<string, any>) => Promise<string>;
function writeTarget(name: string, args: Record<string, any>): string | null {
  if (name === "write_file") return path.resolve(WORKSPACE, args.path);
  return null; // teaching version only path-checks write_file; real Codex sandboxes every exec
}
const withSandbox =
  (next: Dispatch): Dispatch =>
  async (name, args) => {
    const target = writeTarget(name, args);
    if (target && !target.startsWith(WORKSPACE + path.sep)) {
      say("sandbox", C.r, `DENIED write outside workspace → ${target}`);
      return `Error: sandbox_mode=workspace-write refused to write outside ${WORKSPACE}`;
    }
    if (target) say("sandbox", C.g, `allowed write in workspace → ${C.d}${path.relative(WORKSPACE, target)}${C.x}`);
    return next(name, args);
  };

// ── s03 · approval layer (approval_policy = on-request) ────────────────────
// In a real session "ask" pauses for a human y/n. The offline demo auto-answers:
// destructive commands are refused, everything else is approved — so you can see
// both branches without a human attached.
type Verdict = "allow" | "ask";
function classify(name: string, args: Record<string, any>): Verdict {
  if (name === "shell" && /(rm\s+-rf|git push --force|sudo)/.test(args.command)) return "ask";
  return "allow";
}
const withApproval =
  (next: Dispatch): Dispatch =>
  async (name, args) => {
    if (classify(name, args) === "ask") {
      say("approval", C.y, `policy=on-request → needs human; demo auto-answers "no"`);
      return "Error: approval_policy=on-request and the operator denied this command";
    }
    say("approval", C.g, `policy=on-request → auto-approved`);
    return next(name, args);
  };

// ── NEW in s20: compose every mechanism as a layer around one loop ──────────
// Past chapters bolted their mechanism inline. The capstone move is to write
// each as a higher-order wrapper (with*) and compose them, so the s01 loop
// underneath never changes. Registry at the core, wrapped by approval, then sandbox.
const baseDispatch: Dispatch = async (name, args) => {
  const handler = REGISTRY.get(name);
  if (!handler) return `Error: unknown tool "${name}"`;
  return handler(args);
};
const dispatch = withSandbox(withApproval(baseDispatch));

// ── s09 · memory layer: wrap the model call, persist every turn ────────────
type ModelFn = (input: unknown[]) => Promise<OutputItem[]>;
const withMemory =
  (next: ModelFn): ModelFn =>
  async (input) => {
    const output = await next(input);
    fs.appendFileSync(ROLLOUT, output.map((i) => JSON.stringify(i)).join("\n") + "\n");
    say("memory", C.d, `rollout +${output.length} item(s) → ${path.basename(ROLLOUT)} (codex resume could reload this)`);
    return output;
  };

// ── Model adapter: real Responses API, or the offline scripted model ───────
const openai = OFFLINE ? null : new OpenAI();
const INSTRUCTIONS =
  `You are a full Codex-style coding agent working in ${WORKSPACE}. ` +
  `Plan with update_plan, use tools, delegate research to a sub-agent, and finish.`;

async function rawModel(input: unknown[], isChild: boolean): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions: isChild ? "Answer the subtask concisely." : INSTRUCTIONS,
      input: input as never,
      tools: isChild ? [] : TOOLS,
      reasoning: { effort: "medium" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return isChild ? childModel(input) : offlineModel(input);
}
const callModel: ModelFn = (input) => withMemory((i) => rawModel(i, false))(input);
const callChildModel: ModelFn = (input) => rawModel(input, true);

// The offline script drives ONE tool call per turn through every layer, so the
// narrated trace shows each mechanism firing exactly once.
function offlineModel(input: unknown[]): OutputItem[] {
  const done = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  const call = (n: number, name: string, args: Record<string, any>): OutputItem =>
    ({ type: "function_call", id: `call_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args) });
    const plan = [
      { step: "Sketch a plan", status: "completed" },
      { step: "Try a destructive command (approval should refuse)", status: "in_progress" },
      { step: "Write notes inside and outside the workspace (sandbox)", status: "pending" },
      { step: "Search docs via MCP and delegate a summary to a sub-agent", status: "pending" },
    ];
  switch (done) {
    case 0: return [call(1, "update_plan", { plan })];
    case 1: return [call(2, "shell", { command: "git push --force origin main" })]; // approval denies
    case 2: return [call(3, "shell", { command: "echo 'building notes...'" })];     // approval ok
    case 3: return [call(4, "write_file", { path: "/etc/evil.txt", content: "x" })]; // sandbox denies
    case 4: return [call(5, "write_file", { path: "notes.md", content: "# Agent Loop\nThe loop is still s01.\n" })];
    case 5: return [call(6, "mcp__docs__search", { query: "agent loop" })];
    case 6: return [call(7, "spawn_subagent", { task: "In one sentence, what is an agent harness?" })];
    default:
      return [{ type: "message", content: [{ type: "output_text", text:
        `[offline demo] Done. The plan tracked 4 steps; approval refused the force-push, ` +
        `the sandbox refused the /etc write but allowed notes.md, the MCP docs server answered, ` +
        `and a sub-agent summarised the concept — all around the same s01 loop. Set OPENAI_API_KEY to drive it for real.` }] }];
  }
}
function childModel(_input: unknown[]): OutputItem[] {
  return [{ type: "message", content: [{ type: "output_text", text:
    "A harness is the frame around the model: it executes tool calls and feeds results back so the model can keep acting." }] }];
}

// ── The core pattern (UNCHANGED since s01): loop until the model stops ─────
async function agentLoop(input: unknown[], isChild = false): Promise<string> {
  const model = isChild ? callChildModel : callModel;
  for (;;) {
    const output = await model(input);
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
      const args = JSON.parse(call.arguments ?? "{}") as Record<string, any>;
      if (!isChild) console.log(`${C.y}⚙ ${call.name}${C.x} ${C.d}${call.arguments}${C.x}`);
      const result = await dispatch(call.name ?? "", args);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a self-running narrated trace ──────────────────────────────
async function main(): Promise<void> {
  console.log("s20: The Full Harness (Codex-style)");
  console.log(OFFLINE ? "Offline scripted model — watch each layer fire.\n" : `Model: ${MODEL}.\n`);
  console.log(`${C.d}workspace (sandbox root): ${WORKSPACE}${C.x}`);
  connectMcp("docs"); // s19: bridge MCP tools into the registry before the loop
  console.log(`\n${C.b}═══ task: "write short notes about the agent loop" ═══${C.x}\n`);

  const thread: unknown[] = [{ role: "user", content: "Write short notes about the agent loop." }];
  const answer = await agentLoop(thread);

  console.log(`\n${C.g}── final answer ──${C.x}\n${answer}`);
  console.log(`\n${C.d}rollout persisted to ${ROLLOUT}${C.x}`);
  console.log(`${C.d}mechanisms: registry(s02) approval(s03) sandbox(s04) plan(s05) subagent(s06) memory(s09) mcp(s19) — loop(s01) unchanged.${C.x}`);
}

main();
