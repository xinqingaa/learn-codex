#!/usr/bin/env tsx
/**
 * s18_worktree_isolation/code.ts — Git worktree isolation (local parallel sessions)
 *
 * s17's workers self-claimed — but they still share ONE cwd. Alice writes
 * app.txt; bob writes app.txt; they clobber each other.
 *
 * Codex App/CLI give each parallel session its own git worktree (another
 * checkout, same .git). Cloud isolation (container / micro-VM + PR) is s23.
 * The model has no create_worktree tool: the harness picks the cwd first.
 *
 * Teaching extra: named branches wt/t1, wt/t2 plus merge --no-ff so the
 * deferred conflict is visible. App default is detached HEAD; Codex does
 * not auto-merge into main.
 *
 *      repo/main  app.txt="base"          (.git is shared)
 *         │  git worktree add ../wt-t1 -b wt/t1
 *         │  git worktree add ../wt-t2 -b wt/t2
 *         ├─ wt-t1/  alice rewrites app.txt
 *         └─ wt-t2/  bob   rewrites app.txt     SAME path, DIFFERENT content
 *
 * Run it (self-running narrated demo, builds a temp git repo):
 *     npx tsx s18_worktree_isolation/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s18_worktree_isolation/code.ts
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

type Job = { id: string; title: string; dir: string; branch: string };

// ── NEW in s18: the git worktree lifecycle ───────────────────────────────────
// One isolated directory + one branch per session. Parallel agents never share
// a cwd, so their edits to the same path cannot clobber each other mid-work.
function git(cwd: string, args: string): string {
  return String(execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] })).trim();
}
function createWorktree(repo: string, dir: string, branch: string): void {
  git(repo, `worktree add "${dir}" -b "${branch}"`); // new dir + named branch from HEAD
}
function mergeBack(repo: string, branch: string): boolean {
  // Teaching extra: Codex does not auto-merge. We merge so the conflict is visible.
  try { git(repo, `merge --no-ff "${branch}" -m "merge ${branch}"`); return true; }
  catch { return false; } // non-zero exit = git stopped on a real conflict
}
function removeWorktree(repo: string, dir: string, branch: string): void {
  git(repo, `worktree remove --force "${dir}"`);
  git(repo, `branch -D "${branch}"`);
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
async function callModel(input: unknown[], worker: string, job: Job): Promise<OutputItem[]> {
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
  return offlineModel(input, worker, job);
}
function offlineModel(input: unknown[], worker: string, job: Job): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  if (ran === 0) {
    return [{
      type: "function_call", id: `c_${job.id}`, call_id: `c_${job.id}`, name: "write_file",
      arguments: JSON.stringify({ filename: "app.txt", content: `base\n${worker}: ${job.title}\n` }),
    }];
  }
  return [{
    type: "message",
    content: [{ type: "output_text", text: `[offline demo] ${worker} updated app.txt inside its own worktree.` }],
  }];
}

// ── A worker: already given a worktree (parent-assigned, like two Codex sessions)
async function worker(name: string, job: Job): Promise<void> {
  say(name, `session → ${path.basename(job.dir)}/  (branch ${job.branch})`);
  const input: unknown[] = [{ role: "user", content: `Task "${job.title}": update app.txt to record that you did it.` }];
  await sleep(120);
  for (let step = 0; step < 4; step++) {
    const output = await callModel(input, name, job);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) break;
    for (const call of calls) {
      const { filename, content } = JSON.parse(call.arguments ?? "{}") as { filename: string; content: string };
      say(name, `\x1b[33mwrite_file\x1b[0m ${path.basename(job.dir)}/${filename}`);
      const out = writeArtifact(job.dir, filename, content);
      input.push({ type: "function_call_output", call_id: call.call_id, output: out });
    }
  }
  git(job.dir, "add -A");
  git(job.dir, `commit -m "${job.id}: ${job.title}"`);
  say(name, `\x1b[32mcommitted\x1b[0m on ${job.branch}`);
}

// ── Self-running narrated demo ────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("s18: Git Worktree Isolation (local parallel sessions)");
  console.log(
    OFFLINE
      ? "Offline demo model (no OPENAI_API_KEY). Two sessions edit the same file in disjoint worktrees.\n"
      : `Model: ${MODEL}. Two sessions edit the same file in disjoint worktrees.\n`
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

  // Root opens two sessions — like the App starting two Worktree chats.
  // Not s17 claiming. Not a Cloud container.
  const jobs: Job[] = [
    { id: "t1", title: "design the schema", dir: path.join(root, "wt-t1"), branch: "wt/t1" },
    { id: "t2", title: "write the routes", dir: path.join(root, "wt-t2"), branch: "wt/t2" },
  ];
  for (const job of jobs) createWorktree(repo, job.dir, job.branch);
  say("root", "opened wt-t1 (wt/t1) and wt-t2 (wt/t2) — not claiming, not Cloud");

  await Promise.all([worker("alice", jobs[0]!), worker("bob", jobs[1]!)]);

  say("repo", "both sessions edited the SAME path app.txt — on disk side by side:");
  for (const job of jobs) {
    const text = fs.readFileSync(path.join(job.dir, "app.txt"), "utf8");
    say("repo", `  ${path.basename(job.dir)}/app.txt = ${JSON.stringify(text)}`);
  }
  say("repo", "\x1b[2m" + git(repo, "worktree list").split("\n").join("\n  ") + "\x1b[0m");

  for (const job of jobs) {
    if (mergeBack(repo, job.branch)) {
      say("merge", `\x1b[32m${job.branch} merged\x1b[0m into main`);
      removeWorktree(repo, job.dir, job.branch);
      say("merge", `worktree ${path.basename(job.dir)}/ removed, branch deleted — the work is on main`);
    } else {
      say("merge", `\x1b[33m${job.branch} CONFLICTS\x1b[0m on app.txt — git refuses to auto-merge`);
      git(repo, "merge --abort");
      say("merge", `merge --abort; keep ${path.basename(job.dir)}/ + branch ${job.branch} for human review`);
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
