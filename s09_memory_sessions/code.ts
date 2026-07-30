#!/usr/bin/env tsx
/**
 * s09_memory_sessions/code.ts — Session Lifecycle: resume, fork, archive, delete
 *
 * s01's thread lives only in memory: kill the process and the whole session is
 * gone. Codex instead writes every session to disk as it happens, so a session
 * has a *lifecycle* that outlives any single process:
 *
 *      new session ──write-through──▶ rollout-<id>.jsonl   (one item per line)
 *           │
 *           ├─ codex resume   <id>   read lines → rebuild thread → keep going
 *           ├─ codex fork     <id>   copy the file under a NEW id → branch it
 *           ├─ codex archive  <id>   move it aside → hidden from the picker
 *           ├─ codex unarchive <id>  bring it back into the picker
 *           └─ codex delete   <id>   remove the file for good
 *
 *      in-memory thread:  [u1][a1][u2][a2]...        (dies with the process)
 *      rollout-<id>.jsonl: {u1}\n{a1}\n{u2}\n{a2}...  (survives → the lifecycle)
 *
 * Real Codex keeps these under $CODEX_HOME (~/.codex/sessions/, layered by date)
 * and drives them with `codex resume|fork|archive|unarchive|delete`. This chapter
 * models that whole store in TypeScript: write-through append, replay-to-resume,
 * copy-to-fork, and a directory layout that archive/delete operate on.
 *
 * Run it (offline, no key needed — a scripted model drives the loop):
 *     npm install
 *     npx tsx s09_memory_sessions/code.ts                  # narrated lifecycle demo
 *     npx tsx s09_memory_sessions/code.ts --resume         # resume the most recent session
 *     OPENAI_API_KEY=sk-... npx tsx s09_memory_sessions/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

const INSTRUCTIONS =
  `You are a coding agent running in ${CWD}. ` +
  `Use the shell tool to solve the task. Act, don't explain.`;

// ── NEW in s09: a session store — one rollout file per session ──────────────
// Real Codex writes ~/.codex/sessions/<date>/rollout-<ts>-<id>.jsonl and keeps
// archived sessions out of the default picker. We default to the OS temp dir so
// the demo never dirties your repo; set CODEX_SESSIONS to pick another root.
const SESSIONS_DIR = process.env.CODEX_SESSIONS ?? join(tmpdir(), "learn-codex-s09", "sessions");
const ARCHIVE_DIR = join(SESSIONS_DIR, "archived");
const rolloutPath = (id: string): string => join(SESSIONS_DIR, `rollout-${id}.jsonl`);
const archivedPath = (id: string): string => join(ARCHIVE_DIR, `rollout-${id}.jsonl`);
const newId = (): string => `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

interface SessionMeta {
  type: "session_meta";
  id: string;
  cwd: string;
  started: string;
  forked_from?: string;
}

// Open a brand-new session: write the session_meta header, truncating any old file.
function startRollout(id: string, forkedFrom?: string): string {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const meta: SessionMeta = {
    type: "session_meta",
    id,
    cwd: CWD,
    started: new Date().toISOString(),
    ...(forkedFrom ? { forked_from: forkedFrom } : {}),
  };
  writeFileSync(rolloutPath(id), JSON.stringify(meta) + "\n");
  return rolloutPath(id);
}

// Write-through: persist items the moment they are produced, one JSON per line.
function appendRollout(path: string, items: unknown[]): void {
  if (items.length === 0) return;
  appendFileSync(path, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
}

// `codex resume`: read the log back and replay every item into a fresh thread.
function loadRollout(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { type?: string })
    .filter((r) => r.type !== "session_meta");
}

// `codex fork`: branch a session into a NEW copy — same history, fresh id and
// header, parent recorded in forked_from. The source file is left untouched.
function forkSession(srcId: string): string {
  const history = loadRollout(rolloutPath(srcId)); // all items, meta already skipped
  const id = newId();
  startRollout(id, srcId); // fresh header records the parent
  appendRollout(rolloutPath(id), history); // then the full copied history
  return id;
}

// `codex archive` / `unarchive`: move the file aside and back. An archived
// session is hidden from the default picker but nothing is deleted.
function archiveSession(id: string): void {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  if (existsSync(rolloutPath(id))) renameSync(rolloutPath(id), archivedPath(id));
}
function unarchiveSession(id: string): void {
  if (existsSync(archivedPath(id))) renameSync(archivedPath(id), rolloutPath(id));
}

// `codex delete`: remove the rollout file (and any archived copy) for good.
function deleteSession(id: string): void {
  rmSync(rolloutPath(id), { force: true });
  rmSync(archivedPath(id), { force: true });
}

// The picker: list the sessions the user can resume (archived ones are hidden).
function readMeta(path: string): SessionMeta | null {
  const first = existsSync(path) ? readFileSync(path, "utf8").split("\n")[0] : "";
  if (!first.trim()) return null;
  const m = JSON.parse(first) as SessionMeta;
  return m.type === "session_meta" ? m : null;
}
function listSessions(includeArchived = false): SessionMeta[] {
  const dirs = includeArchived ? [SESSIONS_DIR, ARCHIVE_DIR] : [SESSIONS_DIR];
  const metas: SessionMeta[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d))
      if (f.endsWith(".jsonl")) {
        const m = readMeta(join(d, f));
        if (m) metas.push(m);
      }
  }
  return metas.sort((a, b) => a.started.localeCompare(b.started));
}

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

// Offline stand-in: one shell call, then an answer that reports how much state
// is on disk — proof the log (not the process) is what carries the session.
let callSeq = 0;
function offlineModel(input: unknown[]): OutputItem[] {
  const last = input[input.length - 1] as { type?: string } | undefined;
  if (last?.type === "function_call_output") {
    return [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text:
              `[offline demo] Turn done. The thread now holds ${input.length} item(s); ` +
              `each is a JSON line in the rollout file, so resume/fork rebuild this exact state.`,
          },
        ],
      },
    ];
  }
  const id = `call_${++callSeq}`;
  return [
    {
      type: "function_call",
      id,
      call_id: id,
      name: "shell",
      arguments: JSON.stringify({ command: `echo "turn ${callSeq}: logged to rollout"` }),
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

// Run one user turn against a session and persist everything it adds.
async function runTurn(thread: unknown[], rolloutFile: string, query: string): Promise<void> {
  console.log(`\x1b[36ms09 >> \x1b[0m${query}`);
  const userItem = { role: "user", content: query };
  thread.push(userItem);
  appendRollout(rolloutFile, [userItem]); // persist the user turn first
  const before = thread.length;
  await agentLoop(thread);
  appendRollout(rolloutFile, thread.slice(before)); // then everything the turn added
  console.log();
}

// ── Narration helpers for the self-running lifecycle demo ───────────────────
const section = (t: string): void => console.log(`\x1b[1m── ${t} ──\x1b[0m`);
function printStore(): void {
  const visible = listSessions();
  const archived = listSessions(true).length - visible.length;
  console.log(
    `\x1b[35m[picker] visible (${visible.length}): ${visible.map((m) => m.id).join(", ") || "(none)"}` +
      `   archived (${archived})\x1b[0m\n`,
  );
}

// ── Entry point: walk the whole session lifecycle, narrated ────────────────
async function main(): Promise<void> {
  console.log("s09: Session Lifecycle — resume, fork, archive, delete (Codex-style)");
  console.log(OFFLINE ? "Offline demo model (no key).\n" : `Model: ${MODEL}.\n`);

  // `--resume`: genuinely continue the most recent on-disk session and exit.
  if (process.argv.includes("--resume")) {
    const last = listSessions(true).at(-1);
    if (!last) return console.log("no saved session to resume.");
    const thread = loadRollout(rolloutPath(last.id));
    console.log(`\x1b[35m[resume] ${last.id}: ${thread.length} item(s) replayed\x1b[0m\n`);
    await runTurn(thread, rolloutPath(last.id), "Continue where we left off.");
    return;
  }

  section("1. new session — write-through to rollout-<id>.jsonl");
  const a = newId();
  const pathA = startRollout(a);
  const threadA: unknown[] = [];
  await runTurn(threadA, pathA, "Show the working directory.");
  await runTurn(threadA, pathA, "Print a hello line.");

  section("2. codex resume — rebuild the thread from disk and keep going");
  const restored = loadRollout(pathA);
  console.log(`\x1b[35m[resume] ${a}: rebuilt ${restored.length} item(s) from the log\x1b[0m`);
  await runTurn(restored, pathA, "What did we do before the restart?");

  section("3. codex fork — branch the session into a NEW copy");
  const b = forkSession(a);
  console.log(`\x1b[35m[fork] ${a} → ${b}  (same history, new id, forked_from recorded)\x1b[0m`);
  const threadB = loadRollout(rolloutPath(b));
  await runTurn(threadB, rolloutPath(b), "You are the forked copy; explore a different idea.");

  section("4. the picker lists every non-archived session");
  printStore();

  section("5. codex archive — hide a session from the default picker");
  archiveSession(a);
  console.log(`\x1b[35m[archive] ${a} moved aside (not deleted)\x1b[0m`);
  printStore();

  section("6. codex unarchive — bring it back");
  unarchiveSession(a);
  printStore();

  section("7. codex delete — remove the fork for good");
  deleteSession(b);
  console.log(`\x1b[35m[delete] ${b} removed\x1b[0m`);
  printStore();

  console.log(`\x1b[90mSession store: ${SESSIONS_DIR}\x1b[0m`);
}

main();
