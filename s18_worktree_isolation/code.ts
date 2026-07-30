#!/usr/bin/env tsx
/**
 * s18_worktree_isolation/code.ts — Git Worktree Isolation (Codex-style, in TypeScript)
 *
 * s17 let idle workers self-claim tasks — but they all share ONE working
 * directory. Alice edits app.txt for her task; Bob edits app.txt for his; each
 * overwrites the other and nobody can say which change belongs to which task.
 * This chapter gives every task its OWN directory: a git worktree on its own
 * branch (this is exactly the Codex Cloud model — one worktree per task).
 *
 *        one repo (.git)                a disjoint directory per task
 *      ┌──────────────────┐
 *      │ main  app.txt     │   git worktree add ../wt-t1 -b wt/t1
 *      │       ="base"     │   git worktree add ../wt-t2 -b wt/t2
 *      └────────┬─────────┘
 *       ┌───────┴────────┬──────────────────────────────┐
 *       │ wt-t1/ (wt/t1) │  alice rewrites app.txt here │
 *       │ wt-t2/ (wt/t2) │  bob rewrites app.txt here   │  SAME path,
 *       └────────────────┴──────────────────────────────┘  DIFFERENT content,
 *                                                           both on disk at once
 *
 * Parallel edits never collide because each agent works in a disjoint directory.
 * Afterwards each branch is merged back — git surfaces any real conflict (the
 * Codex Cloud "open a PR" moment) — and the worktree is removed or kept.
 *
 * Run it (self-running narrated demo, builds a temp git repo):
 *     npm install
 *     npx tsx s18_worktree_isolation/code.ts                       # offline demo
 *     OPENAI_API_KEY=sk-... npx tsx s18_worktree_isolation/code.ts # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
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
  console.log(`\x1b[2m${t}s\x1b[0m \x1b[36m${actor.padEnd(6)}\x1b[0m ${msg}`);
}

// ── Task board (from s17, trimmed): each task is bound to its own worktree ──
type Task = { id: string; title: string; worktree: string; status: "pending" | "in_progress" | "done"; owner?: string };
class TaskBoard {
  private tasks = new Map<string, Task>();
  add(t: Task): void { this.tasks.set(t.id, t); }
  all(): Task[] { return [...this.tasks.values()]; }
  // Synchronous scan+claim: safe on one event loop (no await between the two).
  claimNext(owner: string): Task | undefined {
    const t = this.all().find((x) => x.status === "pending");
    if (t) { t.status = "in_progress"; t.owner = owner; }
    return t;
  }
  complete(id: string): void { const t = this.tasks.get(id); if (t) t.status = "done"; }
}

// ── NEW in s18: the git worktree lifecycle ───────────────────────────────────
// One isolated directory + one branch per task. Parallel agents never share a
// cwd, so their edits to the same file cannot clobber each other mid-work.
function git(repo: string, args: string): string {
  return String(execSync(`git ${args}`, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })).trim();
}
function createWorktree(repo: string, root: string, task: Task): { dir: string; branch: string } {
  const dir = path.join(root, task.worktree);
  const branch = `wt/${task.id}`;
  git(repo, `worktree add "${dir}" -b ${branch}`); // new dir + new branch from HEAD
  return { dir, branch };
}
function mergeBack(repo: string, branch: string): boolean {
  try { git(repo, `merge --no-ff ${branch} -m "merge ${branch}"`); return true; }
  catch { return false; } // non-zero exit = git stopped on a real conflict
}
function removeWorktree(repo: string, dir: string, branch: string): void {
  git(repo, `worktree remove --force "${dir}"`);
  git(repo, `branch -D ${branch}`);
}

// ── The one tool a worker uses inside its worktree ──────────────────────────
const TOOLS = [
  {
    type: "function" as const,
    name: "write_file",
    description: "Write text to a file inside the current worktree.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "File name (no directories)." },
        content: { type: "string", description: "The text to write." },
      },
      required: ["filename", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
];
function writeArtifact(dir: string, filename: string, content: string): string {
  const p = path.join(dir, path.basename(filename)); // never escape the worktree
  fs.writeFileSync(p, content);
  return `wrote ${content.length} bytes to ${p}`;
}

// ── Model adapter (same shape as s01) ────────────────────────────────────────
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};
async function callModel(input: unknown[], worker: string, task: Task): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions:
        `You are worker '${worker}' in an isolated git worktree. Call write_file once ` +
        `to update app.txt for the task, then stop. Act, don't explain.`,
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "low" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input, worker, task);
}
// Scripted stand-in: rewrite app.txt with this worker's line, then wrap up.
function offlineModel(input: unknown[], worker: string, task: Task): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (ran === 0) {
    return [{
      type: "function_call", id: `c_${task.id}`, call_id: `c_${task.id}`, name: "write_file",
      arguments: JSON.stringify({ filename: "app.txt", content: `base\n${worker}: ${task.title}\n` }),
    }];
  }
  return [{
    type: "message",
    content: [{ type: "output_text", text: `[offline demo] ${worker} updated app.txt inside its own worktree.` }],
  }];
}

// ── A worker: claim a task, run it INSIDE its own worktree, commit ──────────
async function worker(name: string, board: TaskBoard, repo: string, root: string): Promise<void> {
  const task = board.claimNext(name);
  if (!task) { say(name, "nothing to claim — exiting"); return; }
  say(name, `\x1b[35mclaimed\x1b[0m ${task.id}: ${task.title}`);
  const wt = createWorktree(repo, root, task);
  say(name, `worktree → ${task.worktree}/  (branch wt/${task.id})`);

  const input: unknown[] = [{ role: "user", content: `Task "${task.title}": update app.txt to record that you did it.` }];
  await sleep(120); // let the two workers interleave in the trace
  for (let step = 0; step < 4; step++) {
    const output = await callModel(input, name, task);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) break;
    for (const call of calls) {
      const { filename, content } = JSON.parse(call.arguments ?? "{}") as { filename: string; content: string };
      say(name, `\x1b[33mwrite_file\x1b[0m ${task.worktree}/${filename}`);
      const out = writeArtifact(wt.dir, filename, content);
      input.push({ type: "function_call_output", call_id: call.call_id, output: out });
    }
  }
  git(wt.dir, "add -A");
  git(wt.dir, `commit -m "${task.id}: ${task.title}"`);
  say(name, `\x1b[32mcommitted\x1b[0m on wt/${task.id}`);
  board.complete(task.id);
}

// ── Self-running narrated demo ────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s18: Git Worktree Isolation (Codex-style)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Two workers edit the same file in disjoint worktrees.\n"
      : `Model: ${MODEL}. Two workers edit the same file in disjoint worktrees.\n`
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s18-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init -b main");
  git(repo, "config user.email demo@codex.dev");
  git(repo, "config user.name codex-demo");
  git(repo, "config commit.gpgsign false");
  fs.writeFileSync(path.join(repo, "app.txt"), "base\n");
  git(repo, "add -A");
  git(repo, 'commit -m "initial"');
  say("repo", `temp git repo → ${repo}`);

  const board = new TaskBoard();
  board.add({ id: "t1", title: "design the schema", worktree: "wt-t1", status: "pending" });
  board.add({ id: "t2", title: "write the routes", worktree: "wt-t2", status: "pending" });
  say("board", "seeded 2 tasks — each is bound to its own worktree");

  await Promise.all([worker("alice", board, repo, root), worker("bob", board, repo, root)]);

  // The isolation proof: the SAME path was edited in two places at once.
  say("repo", "both workers edited the SAME path app.txt — on disk side by side:");
  for (const t of board.all()) {
    const text = fs.readFileSync(path.join(root, t.worktree, "app.txt"), "utf8");
    say("repo", `  ${t.worktree}/app.txt = ${JSON.stringify(text)}`);
  }
  say("repo", "\x1b[2m" + git(repo, "worktree list").split("\n").join("\n  ") + "\x1b[0m");

  // Merge each branch back. Disjoint edits would merge cleanly; here both
  // touched app.txt, so the second merge is a genuine conflict — the honest
  // signal Codex Cloud turns into a PR for a human.
  for (const t of board.all()) {
    const branch = `wt/${t.id}`;
    if (mergeBack(repo, branch)) {
      say("merge", `\x1b[32m${branch} merged\x1b[0m into main`);
      removeWorktree(repo, path.join(root, t.worktree), branch);
      say("merge", `worktree ${t.worktree}/ removed, branch deleted — the work is on main`);
    } else {
      say("merge", `\x1b[33m${branch} CONFLICTS\x1b[0m on app.txt — git refuses to auto-merge`);
      git(repo, "merge --abort");
      say("merge", `merge --abort; keep ${t.worktree}/ + branch ${branch} for human review`);
    }
  }

  say("repo", `branches left: ${git(repo, "branch --format='%(refname:short)'").split("\n").join(", ")}`);
  console.log(`\nmain's app.txt = ${JSON.stringify(fs.readFileSync(path.join(repo, "app.txt"), "utf8"))}`);
  console.log(`Repo left at ${repo}  (wt-t2 kept for review)`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
