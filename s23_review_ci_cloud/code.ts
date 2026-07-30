#!/usr/bin/env tsx
/**
 * s23_review_ci_cloud/code.ts — Review Mode & Headless Runs (Codex-style, in TypeScript)
 *
 * Every chapter so far ran the loop INTERACTIVELY: a human typed a prompt, watched
 * the turns, approved commands. This chapter runs the SAME s01 loop with no human at
 * the keyboard — which is exactly how the real Codex product ships three surfaces:
 *
 *     codex review    point the loop at a git DIFF; it emits findings, not edits
 *     codex exec      run one task headless;  --json streams the run as JSONL,
 *                     --output-schema forces the final message to match a JSON Schema
 *     CI · Cloud      a GitHub Action (openai/codex-action) or Codex Cloud runs
 *                     `codex exec` for you, unattended, on every PR or delegated task
 *
 *     git diff ──> ┌───────────────┐   {"type":"thread.started",...}
 *     review prompt│  agent loop   │   {"type":"item.completed","item":{...command...}}
 *     + read tools │  (s01, same)  │ > {"type":"item.completed","item":{...agent_message}}
 *                  └───────────────┘   {"type":"turn.completed","usage":{...}}
 *                        the final agent_message IS the JSON findings (--output-schema)
 *
 * The loop never changes. What changes is WHO drives it (a script, CI, the cloud
 * instead of a human) and HOW the answer comes back (a JSONL event stream on stdout
 * plus a schema-validated JSON object a script can consume). Human narration goes to
 * stderr; the machine-readable stream stays clean on stdout.
 *
 * Run it (self-running demo, builds a temp git repo with planted bugs):
 *     npm install
 *     npx tsx s23_review_ci_cloud/code.ts                       # offline demo (no key)
 *     npx tsx s23_review_ci_cloud/code.ts > events.jsonl        # capture just the stream
 *     OPENAI_API_KEY=sk-... npx tsx s23_review_ci_cloud/code.ts # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const openai = OFFLINE ? null : new OpenAI();

// Human narration -> stderr, so stdout carries ONLY the machine-readable stream,
// exactly like `codex exec --json` (pipe stdout to a file or jq; watch stderr live).
const t0 = Date.now();
function say(actor: string, msg: string): void {
  const t = ((Date.now() - t0) / 1000).toFixed(2).padStart(6);
  console.error(`\x1b[2m${t}s\x1b[0m \x1b[36m${actor.padEnd(6)}\x1b[0m ${msg}`);
}

// ── NEW in s23: the `codex exec --json` event stream ─────────────────────────
// Headless mode emits one JSON object per line on stdout. Real event types:
// thread.started / turn.started / item.started / item.completed / turn.completed
// / turn.failed / error. Items are typed: command_execution, agent_message, …
let itemSeq = 0;
function emitEvent(type: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ type, ...extra })); // stdout = machine channel
}

// ── The review target: a temp git repo with a planted, buggy uncommitted change ─
function git(repo: string, args: string): string {
  return String(execSync(`git ${args}`, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })).trim();
}
const BASE_TS = `const MAX_ATTEMPTS = 5;

export function isTokenValid(expiresAt: number, now: number): boolean {
  return now < expiresAt; // valid strictly before the expiry instant
}

export function shouldLock(failedAttempts: number): boolean {
  return failedAttempts > MAX_ATTEMPTS; // lock only after exceeding the limit
}

export function attemptsLeft(failedAttempts: number): number {
  return MAX_ATTEMPTS - failedAttempts; // remaining tries before lockout
}
`;
// The uncommitted edit introduces three diff-visible regressions.
const BUGGY_TS = `const MAX_ATTEMPTS = 5;

export function isTokenValid(expiresAt: number, now: number): boolean {
  return now <= expiresAt; // valid strictly before the expiry instant
}

export function shouldLock(failedAttempts: number): boolean {
  return failedAttempts < MAX_ATTEMPTS; // lock only after exceeding the limit
}

export function attemptsLeft(failedAttempts: number): number {
  return failedAttempts - MAX_ATTEMPTS; // remaining tries before lockout
}
`;
function buildSampleRepo(): string {
  const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s23-")), "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init -b main");
  git(repo, "config user.email review@codex.dev");
  git(repo, "config user.name codex-review");
  git(repo, "config commit.gpgsign false");
  fs.writeFileSync(path.join(repo, "src", "login.ts"), BASE_TS);
  git(repo, "add -A");
  git(repo, 'commit -m "base login helpers"');
  fs.writeFileSync(path.join(repo, "src", "login.ts"), BUGGY_TS); // uncommitted change
  return repo;
}

// ── The one tool the reviewer gets: a shell scoped to the repo (read-only) ────
const TOOLS = [
  {
    type: "function" as const,
    name: "shell",
    description: "Run a read-only shell command inside the repo under review (e.g. cat, sed, grep) to inspect context around the diff.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
];
function runShell(cwd: string, command: string): string {
  const dangerous = ["rm -rf /", "sudo ", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: dangerous command blocked";
  try {
    const out = execSync(command, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 });
    return (String(out).trim() || "(no output)").slice(0, 20_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

// ── NEW in s23: review instructions + an --output-schema for the final message ─
const REVIEW_INSTRUCTIONS =
  `You are Codex running in review mode. You are given a unified git diff. ` +
  `Find real, prioritized problems the change would introduce — correctness bugs, ` +
  `security holes, regressions — citing file and line. Use the shell only to read ` +
  `surrounding context; NEVER edit files. When done, reply with ONLY a JSON object ` +
  `matching the provided schema: overall_correctness plus a findings[] array.`;
// Mirrors `codex exec --output-schema findings.schema.json`: the final agent message
// is constrained to this JSON Schema so a script can rely on its fields.
const FINDINGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["overall_correctness", "findings"],
  properties: {
    overall_correctness: { type: "string", enum: ["patch is correct", "patch is incorrect"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "file", "line", "severity"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
  },
};
interface Finding { title: string; body: string; file: string; line: number; severity: string }
interface ReviewResult { overall_correctness: string; findings: Finding[] }
function parseFindings(text: string): ReviewResult | null {
  try {
    const obj = JSON.parse(text) as Partial<ReviewResult>;
    if (typeof obj.overall_correctness !== "string" || !Array.isArray(obj.findings)) return null;
    return obj as ReviewResult;
  } catch {
    return null; // a real run would re-ask the model; the schema makes this rare
  }
}

// ── Model adapter (same Responses-API shape as s01) ───────────────────────────
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};
async function callModel(input: unknown[], opts: ExecOptions): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions: opts.instructions, // review-mode system prompt
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "medium" },
      // --output-schema → constrain the final message via Structured Outputs.
      ...(opts.schema
        ? { text: { format: { type: "json_schema" as const, name: "review_findings", schema: opts.schema, strict: true } } }
        : {}),
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input);
}
// Offline stand-in reviewer: it opens the changed file for line numbers, then
// emits the findings as schema-shaped JSON — the same flow a real review takes.
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (ran === 0) {
    return [{
      type: "function_call", id: "call_read", call_id: "call_read", name: "shell",
      arguments: JSON.stringify({ command: "cat -n src/login.ts" }),
    }];
  }
  const result: ReviewResult = {
    overall_correctness: "patch is incorrect",
    findings: [
      { title: "shouldLock comparison is inverted", body: "Now locks a user on their FIRST failed attempt and never locks a brute-force attacker past the limit. Restore `failedAttempts > MAX_ATTEMPTS`.", file: "src/login.ts", line: 8, severity: "high" },
      { title: "Token accepted at the exact expiry instant", body: "`now <= expiresAt` keeps a token valid one instant past expiry. Should be `now < expiresAt`.", file: "src/login.ts", line: 4, severity: "medium" },
      { title: "attemptsLeft goes negative", body: "Operands swapped (`failedAttempts - MAX_ATTEMPTS`), so the remaining-try count is negative for normal users. Restore `MAX_ATTEMPTS - failedAttempts`.", file: "src/login.ts", line: 12, severity: "low" },
    ],
  };
  return [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }];
}

// ── NEW in s23: the headless exec path (`codex exec`) ────────────────────────
// Runs ONE task to completion with no human. With json:true it streams the run as
// JSONL events; with schema set it validates the final message. Returns the final
// agent message (the structured payload a script consumes).
interface ExecOptions {
  instructions: string;
  cwd: string;                    // -C / --cd
  json?: boolean;                 // --json
  schema?: Record<string, unknown>; // --output-schema
}
function approxUsage(input: unknown[]): Record<string, number> {
  const chars = JSON.stringify(input).length; // offline estimate; real Codex reports exact usage
  return { input_tokens: Math.ceil(chars / 4), cached_input_tokens: 0, output_tokens: Math.ceil(chars / 24), reasoning_output_tokens: 0 };
}
async function codexExec(prompt: string, opts: ExecOptions): Promise<string> {
  if (opts.json) emitEvent("thread.started", { thread_id: `thr_${Date.now().toString(36)}` });
  if (opts.json) emitEvent("turn.started");
  const input: unknown[] = [{ role: "user", content: prompt }];
  let finalText = "";
  for (let step = 0; step < 8; step++) {
    const output = await callModel(input, opts);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        if (item.type === "message")
          for (const c of item.content ?? [])
            if (c.type === "output_text" && c.text) finalText += c.text;
      if (opts.json) emitEvent("item.completed", { item: { id: `item_${++itemSeq}`, type: "agent_message", text: finalText } });
      break;
    }
    for (const call of calls) {
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      const id = `item_${++itemSeq}`;
      if (opts.json) emitEvent("item.started", { item: { id, type: "command_execution", command, status: "in_progress" } });
      const result = runShell(opts.cwd, command);
      if (opts.json) emitEvent("item.completed", { item: { id, type: "command_execution", command, status: "completed", aggregated_output: result.slice(0, 400) } });
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
  if (opts.json) emitEvent("turn.completed", { usage: approxUsage(input) });
  return finalText;
}

// ── Self-running narrated demo ────────────────────────────────────────────────
async function main(): Promise<void> {
  say("s23", "Review Mode & Headless Runs (Codex-style)");
  say("s23", OFFLINE ? "offline demo model (no key) — a scripted reviewer" : `model: ${MODEL}`);

  // 1. Stage the work: a repo whose uncommitted diff hides three regressions.
  const repo = buildSampleRepo();
  const diff = git(repo, "diff"); // uncommitted → mirrors `codex review --uncommitted`
  say("repo", `temp git repo → ${repo}`);
  say("repo", `planted an uncommitted change to src/login.ts (${diff.split("\n").length} diff lines, 3 bugs)`);
  say("codex", "real equivalents:  `codex review --uncommitted`");
  say("codex", `                  \`codex exec --json --output-schema findings.schema.json -C ${repo} "review the diff"\``);

  // 2. Drive the loop headless in review mode; --json streams events to stdout.
  say("exec", "── stdout below is the machine-readable `codex exec --json` event stream ──");
  const prompt =
    `Review the uncommitted changes in the repo at ${repo}. Here is the diff:\n\n${diff}\n\n` +
    `Open files with the shell if you need context, then report findings as JSON.`;
  const finalMessage = await codexExec(prompt, { instructions: REVIEW_INSTRUCTIONS, cwd: repo, json: true, schema: FINDINGS_SCHEMA });
  say("exec", "── end of stdout event stream ──");

  // 3. The same payload, read by a human: parse the schema-validated findings.
  const review = parseFindings(finalMessage);
  if (review) {
    say("review", `verdict: \x1b[1m${review.overall_correctness}\x1b[0m — ${review.findings.length} finding(s)`);
    for (const f of review.findings)
      say("review", `  [${f.severity.padEnd(6)}] ${f.file}:${f.line}  ${f.title}`);
  } else {
    say("review", "final message did not match the findings schema (would re-ask the model)");
  }

  // 4. Where the same headless run plugs in once it leaves your laptop.
  say("ci", "GitHub Action: `uses: openai/codex-action@v1` with openai-api-key + a review prompt;");
  say("ci", "  it wraps `codex exec`, exposes the final message as the `final-message` output,");
  say("ci", "  and can post it as a PR comment (permission-profile \":read-only\", drop-sudo).");
  say("cloud", "Codex Cloud runs the same loop in an isolated env (clone + setup script + internet");
  say("cloud", "  policy), then returns a diff/PR — drive it with `codex cloud exec|status|diff|apply`.");
  say("s23", `repo left at ${repo}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
