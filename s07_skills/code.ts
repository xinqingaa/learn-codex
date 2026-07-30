#!/usr/bin/env tsx
/**
 * s07_skills/code.ts — Skills: on-demand knowledge loading
 *
 * A project's conventions (React style, SQL guide, commit format) can't all
 * live in the system prompt — it would be thousands of lines the model pays
 * for every single turn. Codex's answer is two-level loading:
 *
 *     startup:   scan skills/ → inject only name + description into instructions
 *                (cheap: a few tokens per skill, always present)
 *     runtime:   the task matches a skill → load_skill(name) →
 *                the full SKILL.md enters the context as a tool result
 *                (expensive, but only when actually needed)
 *
 *     skills/                         instructions
 *       code-review/SKILL.md   --->   "available: code-review, commit-message"
 *       commit-message/SKILL.md       (load one on demand for the full rules)
 *
 * Real Codex reads skills from ~/.codex/skills (user-wide) and .agents/skills
 * (project-level). This chapter uses a local skills/ dir to show the mechanism.
 *
 * Run it:
 *     npm install
 *     npx tsx s07_skills/code.ts          # offline demo model (no key needed)
 *     OPENAI_API_KEY=sk-... npx tsx s07_skills/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

// Resolve skills/ next to this file, so the demo works from any CWD.
const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills");

// ── NEW in s07: scan skills/ at startup, keep only name + description ──────
type Skill = { name: string; description: string; content: string };
const SKILL_REGISTRY = new Map<string, Skill>();

// A minimal YAML-frontmatter parser: just the flat `key: value` lines we need.
function parseFrontmatter(raw: string): Record<string, string> {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return {};
  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).trim().split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return meta;
}

function scanSkills(): void {
  if (!fs.existsSync(SKILLS_DIR)) return;
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(manifest)) continue;
    const raw = fs.readFileSync(manifest, "utf8");
    const meta = parseFrontmatter(raw);
    const name = meta.name ?? entry.name;
    SKILL_REGISTRY.set(name, { name, description: meta.description ?? "", content: raw });
  }
}

scanSkills(); // runs once, at startup

// The instructions carry the CATALOG (cheap), never the full skill bodies.
const INSTRUCTIONS =
  `You are a coding agent running in ${CWD}. ` +
  `Skills are reusable instruction packs. Available skills:\n` +
  ([...SKILL_REGISTRY.values()].map((s) => `- ${s.name}: ${s.description}`).join("\n") || "(none)") +
  `\nWhen the task matches a skill's description, call load_skill to fetch its full instructions, then follow them.`;

// ── Tools: a shell plus, NEW in s07, load_skill ────────────────────────────
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
  {
    type: "function" as const,
    name: "load_skill",
    description: "Load a skill's full instructions by name. Call it only when the task matches that skill.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The skill name from the catalog." } },
      required: ["name"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function runShell(command: string): string {
  const dangerous = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: dangerous command blocked";
  try {
    const out = execSync(command, { cwd: CWD, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return (String(out).trim() || "(no output)").slice(0, 50_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

// ── NEW in s07: look up by name (no path traversal), inject full content ───
function loadSkill(name: string): string {
  const skill = SKILL_REGISTRY.get(name);
  if (!skill) return `Skill not found: ${name}. Available: ${[...SKILL_REGISTRY.keys()].join(", ") || "(none)"}`;
  console.log(`\n\x1b[35m[skill loaded]\x1b[0m ${name} — full instructions injected into context`);
  return skill.content;
}

// ── Model adapter (same shape as s01) ──────────────────────────────────────
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
      model: MODEL,
      instructions: INSTRUCTIONS,
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "medium" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input);
}

// ── Offline demo: the task matches a skill → load it → follow it ───────────
const call = (id: string, name: string, args: unknown): OutputItem => ({
  type: "function_call", id, call_id: id, name, arguments: JSON.stringify(args),
});
const say = (text: string): OutputItem => ({
  type: "message", content: [{ type: "output_text", text }],
});

let pickedSkill = "";
function offlineModel(input: unknown[]): OutputItem[] {
  const outputs = input.filter((i) => (i as { type?: string }).type === "function_call_output");
  if (outputs.length === 0) {
    const task = input
      .filter((i) => (i as { role?: string }).role === "user")
      .map((i) => String((i as { content?: unknown }).content))
      .join(" ")
      .toLowerCase();
    pickedSkill = /commit/.test(task) ? "commit-message" : "code-review";
    return [call("k1", "load_skill", { name: pickedSkill })];
  }
  if (outputs.length === 1) return [call("g1", "shell", { command: "git status --short" })];
  return [say(
    `[offline demo] The task matched the "${pickedSkill}" skill, so I loaded it on demand, ` +
    `gathered the change with one command, and applied the skill's rules to it. The full ` +
    `instructions entered the context only because they were needed — they were never in the ` +
    `system prompt. Set OPENAI_API_KEY for a real model.`
  )];
}

// ── The loop: identical to s01, plus a dispatch on the tool name ───────────
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

    for (const c of calls) {
      const args = JSON.parse(c.arguments ?? "{}") as Record<string, unknown>;
      let result: string;
      if (c.name === "load_skill") {
        result = loadSkill(String(args.name ?? "")); // NEW in s07
      } else {
        console.log(`\x1b[33m$ ${args.command}\x1b[0m`);
        result = runShell(String(args.command ?? ""));
        console.log(result.split("\n").slice(0, 8).join("\n"));
      }
      input.push({ type: "function_call_output", call_id: c.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL ────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s07: Skills (on-demand knowledge loading)");
  console.log(`Scanned ${SKILL_REGISTRY.size} skill(s) from ${path.relative(CWD, SKILLS_DIR) || "skills/"}.`);
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Type a task, or q to quit.\n"
      : `Model: ${MODEL}. Type a task, or q to quit.\n`
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const thread: unknown[] = [];
  for (;;) {
    const query = await new Promise<string>((resolve) => rl.question("\x1b[36ms07 >> \x1b[0m", resolve));
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;
    thread.push({ role: "user", content: query });
    try {
      await agentLoop(thread);
    } catch (err) {
      console.error("agent error:", err);
    }
    console.log();
  }
  rl.close();
}

main();
