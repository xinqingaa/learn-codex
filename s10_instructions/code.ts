#!/usr/bin/env tsx
/**
 * s10_instructions/code.ts — Runtime Instruction Assembly (Codex-style, in TypeScript)
 *
 * Up to now the system prompt has been one hardcoded string. A real harness
 * ASSEMBLES it at runtime from layers, and lets a config file choose the model
 * and how hard it should think:
 *
 *     built-in base instructions      (ships with the harness, always present)
 *   + AGENTS.md                       (the project's own rules, if present)
 *   = the `instructions` string sent to the Responses API
 *
 *   separately, a config.toml-like profile resolves:
 *     model · reasoning effort · approval_policy · sandbox_mode
 *     precedence: env / CLI flag > --profile > config root > built-in default
 *
 *     base ───────┐
 *     AGENTS.md ──┼──> buildInstructions() + resolveConfig() ──> instructions + {model, effort}
 *     config.toml─┘
 *
 * Run it:
 *     npm install
 *     npx tsx s10_instructions/code.ts                          # offline demo (no key)
 *     npx tsx s10_instructions/code.ts --profile deep           # resolve a named profile
 *     OPENAI_API_KEY=sk-... npx tsx s10_instructions/code.ts    # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";

const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

// ── NEW in s10: layer 1 — the built-in base instructions ───────────────────
// Ships with the harness (Codex keeps its base prompt inside codex-rs). Always on.
const BASE_INSTRUCTIONS =
  `You are Codex, a coding agent running in ${CWD}. ` +
  `Use the shell tool to solve the task. Act, don't explain. ` +
  `When a project AGENTS.md is present, follow its instructions too.`;

// ── NEW in s10: layer 2 — the project's AGENTS.md ──────────────────────────
// Codex reads AGENTS.md from the project root (plus ~/.codex/AGENTS.md globally)
// and appends it after the base. We load the sample beside this file so the
// demo behaves the same no matter where you launch it from.
function loadAgentsMd(): string | null {
  const p = fileURLToPath(new URL("./AGENTS.md", import.meta.url));
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}

// ── NEW in s10: layer 3 — a config.toml-like profile ───────────────────────
// Stands in for ~/.codex/config.toml: model, reasoning effort, policies, named
// `profiles` (picked with --profile), and `model_providers` + `wire_api` for
// pointing Codex at a compatible gateway instead of the default API.
type Effort = "low" | "medium" | "high";
interface Profile {
  model?: string;
  model_reasoning_effort?: Effort;
}
interface CodexConfig {
  model?: string;
  model_reasoning_effort?: Effort;
  approval_policy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox_mode?: "read-only" | "workspace-write" | "danger-full-access";
  model_providers?: Record<string, { name: string; wire_api: "responses" | "chat" }>;
  profiles?: Record<string, Profile>;
}

const CONFIG: CodexConfig = {
  model: "gpt-5-codex",
  model_reasoning_effort: "medium",
  approval_policy: "on-request",
  sandbox_mode: "workspace-write",
  model_providers: {
    openai: { name: "OpenAI", wire_api: "responses" },
  },
  profiles: {
    fast: { model: "gpt-5-codex", model_reasoning_effort: "low" },
    deep: { model: "gpt-5-codex", model_reasoning_effort: "high" },
  },
};

// Resolve the effective settings. Precedence, lowest applied first:
//   built-in default < config.toml root < --profile < env / CLI flag.
function resolveConfig(cfg: CodexConfig, profileName?: string) {
  const profile = (profileName ? cfg.profiles?.[profileName] : undefined) ?? {};
  const provider = Object.values(cfg.model_providers ?? {})[0];
  return {
    model: process.env.MODEL_ID ?? profile.model ?? cfg.model ?? "gpt-5-codex",
    effort: profile.model_reasoning_effort ?? cfg.model_reasoning_effort ?? ("medium" as Effort),
    approval_policy: cfg.approval_policy ?? "on-request",
    sandbox_mode: cfg.sandbox_mode ?? "workspace-write",
    provider: provider ? `${provider.name} (${provider.wire_api})` : "(default)",
    profileUsed: profileName && cfg.profiles?.[profileName] ? profileName : "(none)",
  };
}

// Merge the text layers into the single `instructions` string sent to the API.
function buildInstructions(): { text: string; layers: string[] } {
  const layers = ["built-in base"];
  let text = BASE_INSTRUCTIONS;
  const agents = loadAgentsMd();
  if (agents) {
    layers.push("AGENTS.md (project)");
    text += `\n\n# Project instructions (AGENTS.md)\n${agents}`;
  }
  return { text, layers };
}

// Resolved at startup (see main) and shared by the API call and the demo.
let MODEL = "gpt-5-codex";
let EFFORT: Effort = "medium";
let INSTRUCTIONS = BASE_INSTRUCTIONS;

// ── The one tool: a shell (unchanged from s01) ──────────────────────────────
const TOOLS = [
  {
    type: "function" as const,
    name: "shell",
    description: "Run a shell command and return its combined stdout+stderr.",
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
    const out = execSync(command, { cwd: CWD, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return (String(out).trim() || "(no output)").slice(0, 50_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

// ── Model adapter (same Responses-API shape as s01) ─────────────────────────
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

const openai = OFFLINE ? null : new OpenAI();

async function callModel(input: unknown[]): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL, // resolved from the config layers, not hardcoded
      instructions: INSTRUCTIONS, // assembled from base + AGENTS.md
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: EFFORT }, // resolved too
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input);
}

// Offline stand-in: it checks `git status` first *because the project layer
// (AGENTS.md) says to* — proof the assembled instructions drove its behavior.
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (ran === 0) {
    return [
      {
        type: "function_call",
        id: "call_1",
        call_id: "call_1",
        name: "shell",
        arguments: JSON.stringify({ command: "git status --short 2>/dev/null || echo '(not a git repo)'" }),
      },
    ];
  }
  const cited = INSTRUCTIONS.includes("git status")
    ? "the project layer (AGENTS.md) told me to check `git status` before finishing"
    : "no project rule applied (AGENTS.md was not loaded)";
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text:
            `[offline demo] I ran \`git status\` first because ${cited}. My instructions were ` +
            `assembled at runtime from layers, and the config resolved model=${MODEL}, ` +
            `effort=${EFFORT}. Set OPENAI_API_KEY for a real model — the assembly is identical.`,
        },
      ],
    },
  ];
}

// ── The core loop (unchanged from s01) ──────────────────────────────────────
async function agentLoop(input: unknown[]): Promise<void> {
  for (;;) {
    const output = await callModel(input);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        if (item.type === "message")
          for (const c of item.content ?? [])
            if (c.type === "output_text" && c.text) console.log(c.text);
      return;
    }
    for (const call of calls) {
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      console.log(`\x1b[33m$ ${command}\x1b[0m`);
      const result = runShell(command);
      console.log(result);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: assemble, show the layers, then run a REPL ────────────────
async function main(): Promise<void> {
  const pi = process.argv.indexOf("--profile");
  const profileName = pi >= 0 ? process.argv[pi + 1] : undefined;

  const resolved = resolveConfig(CONFIG, profileName);
  MODEL = resolved.model;
  EFFORT = resolved.effort;
  const built = buildInstructions();
  INSTRUCTIONS = built.text;

  console.log("s10: Runtime Instruction Assembly (Codex-style)\n");
  console.log("\x1b[1mAssembled system prompt\x1b[0m  (layers: " + built.layers.join("  +  ") + ")");
  console.log("\x1b[90m" + "─".repeat(64) + "\x1b[0m");
  console.log(INSTRUCTIONS.split("\n").map((l) => "  " + l).join("\n"));
  console.log("\x1b[90m" + "─".repeat(64) + "\x1b[0m");
  console.log(
    `resolved: model=${resolved.model}  effort=${resolved.effort}  ` +
      `approval=${resolved.approval_policy}  sandbox=${resolved.sandbox_mode}\n` +
      `          provider=${resolved.provider}  profile=${resolved.profileUsed}\n`
  );
  console.log(
    OFFLINE
      ? "Offline demo model (no key). Type a task, or q to quit.\n"
      : "Type a task, or q to quit.\n"
  );

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const thread: unknown[] = [];
  process.stdout.write("\x1b[36ms10 >> \x1b[0m");
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
    process.stdout.write("\x1b[36ms10 >> \x1b[0m");
  }
  rl.close();
}

main();
