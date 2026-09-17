# s18: Worktree Isolation — One Task, One Directory

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s17](../s17_autonomous_agents/) → [s18](../s18_worktree_isolation/) → [s19](../s19_mcp_servers/) → ... → s20
> *"One task, one directory"* — parallel hands edit disjoint directories, never colliding.
>
> **Harness layer**: collaboration — directory isolation for local parallel sessions via git worktrees. Cloud containers are s23.

---

## The Problem

s17 let idle workers claim tasks for themselves, but they still share **one working directory**. Alice's task is "design the DB schema", bob's is "write the API routes" — and both happen to rewrite `app.txt`.

Alice calls `write_file("app.txt", ...)`; bob calls `write_file("app.txt", ...)`. Two people writing the same file at the same time **clobber each other**, and afterwards nobody can tell which line belongs to which task.

s15–s17 solved "who does what", but not "**where** the work happens". Local Codex parallelism (the desktop app's Worktree, the CLI's `-C` / experimental `--worktree`) is exactly this: one checkout per session. Cloud container isolation is a different line — that is s23.

---

## The Solution

![Worktree Isolation](images/worktree-isolation.svg)

Give **every session its own git worktree** — another working directory on its own branch, all sharing one `.git`. Alice edits her `app.txt` in `wt-t1/`; bob edits his in `wt-t2/`: **the same path, two different contents, on disk at the same time**, neither overwriting the other.

Root creates two worktrees, then starts alice and bob in parallel — the shape of "the user / the App opens two Worktree chats", not s17 claiming. The model has no `create_worktree` tool: the harness picks the cwd, then opens the loop.

The chapter adds named branches plus `merge --no-ff`: the App default is **detached HEAD**, and Codex does **not** auto-merge into `main`. The merge is only there so "conflict is deferred until you hand the work back" is visible.

| operation | git command | effect |
|-----------|-------------|--------|
| create | `git worktree add <dir> -b wt/<id>` | one directory + one branch per session, sharing a single `.git` |
| isolate | (no command) | the same path `app.txt` edited independently in two directories, both on disk |
| merge (teaching) | `git merge --no-ff wt/<id>` | a clean merge lands on main; git refuses on a real conflict |
| clean up | `git worktree remove` + `git branch -D` | clean merge → delete the directory and branch |
| keep | `git merge --abort` | conflict → roll back the merge, keep the branch (compare App: keep the dir / Create branch / open a PR) |

---

## How It Works

Four pieces: a git helper, creating a worktree, working and committing inside each directory, and a teaching merge-and-clean-up.

**Step 1**: funnel every git call into one synchronous helper that runs in a given directory and returns stdout.

```ts
function git(cwd: string, args: string): string {
  return String(execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] })).trim();
}
```

**Step 2**: `git worktree add <dir> -b <branch>` builds the new directory and the new branch in one command (off the current HEAD). The chapter uses named branches `wt/t1` so the later merge has something to merge; the App default is detached HEAD, so your branch list stays clean.

```ts
function createWorktree(repo: string, dir: string, branch: string): void {
  git(repo, `worktree add "${dir}" -b "${branch}"`); // new dir + named branch, from HEAD
}
```

**Step 3**: the worker is already assigned into its worktree. `write_file` only writes into `job.dir`, never anyone else's. When done, it commits on that branch.

```ts
async function worker(name: string, job: Job): Promise<void> {
  say(name, `session → ${path.basename(job.dir)}/  (branch ${job.branch})`);
  // …run the agent loop inside job.dir: write_file only writes into its own worktree…
  git(job.dir, "add -A");
  git(job.dir, `commit -m "${job.id}: ${job.title}"`);
}
```

Root opens the directories first, then runs the two sessions — workers do not claim:

```ts
for (const job of jobs) createWorktree(repo, job.dir, job.branch);
say("root", "opened wt-t1 (wt/t1) and wt-t2 (wt/t2) — not claiming, not Cloud");
await Promise.all([worker("alice", jobs[0]!), worker("bob", jobs[1]!)]);
```

**Step 4**: the teaching merge. `mergeBack` merges the branch into main with `--no-ff` — `true` on a clean merge, `false` when git exits non-zero on a real conflict; `removeWorktree` deletes the directory and the branch. This is not Codex's product exit.

```ts
function mergeBack(repo: string, branch: string): boolean {
  try { git(repo, `merge --no-ff "${branch}" -m "merge ${branch}"`); return true; }
  catch { return false; } // non-zero exit = git hit a real conflict
}
```

Assembled into the merge loop at the end of the demo:

```ts
for (const job of jobs) {
  if (mergeBack(repo, job.branch)) {
    removeWorktree(repo, job.dir, job.branch);  // clean → delete dir + branch
  } else {
    git(repo, "merge --abort");                 // conflict → keep the branch
  }
}
```

The core insight: **a worktree is "another directory in the same repo", not "another repo".** Every worktree shares one `.git` but has its own working tree — so two people editing the same path don't interfere, because they are simply not in the same directory. Real conflicts don't vanish; they are **deferred until you hand the work back**, where git surfaces them honestly. The chapter uses merge to show that moment. The App's exits are keep-the-directory, Create branch, Handoff, open a PR — not an automatic merge into `main`.

---

## Try It

> **Teaching demo note**: the code builds a **real git repository** under the system temp dir (`os.tmpdir()`) with `git init`, then runs `worktree add`, `commit` and `merge` — all inside that temp directory, never touching your project.

**No API key needed**: this chapter is a **self-running demo** with no REPL. Without `OPENAI_API_KEY` it uses a built-in offline scripted model — root opens two worktrees, alice and bob rewrite the same `app.txt` in their own directories, then it demonstrates one clean merge and one real conflict, narrated throughout.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s18_worktree_isolation/code.ts                # offline demo model
OPENAI_API_KEY=sk-... npx tsx s18_worktree_isolation/code.ts   # real model
```

Try these tweaks:

1. Have the two tasks edit **different** files (e.g. bob writes `routes.txt` instead) and watch both merges come out clean and both worktrees get cleaned up.
2. Run with a real key and watch the model write different content into `app.txt`.
3. Afterwards run `git -C <the repo path it prints> log --oneline --graph` to see the branch-and-merge topology.

Watch for: are the two worktrees' `app.txt` files "same path, different content" at the same time? Why does the first merge come out clean and the second conflict? Is the conflicting branch deleted, or kept for a human?

---

## What's Next

Parallel sessions now have disjoint directories. But their abilities are still capped by the handful of tools we hand-wrote into the harness — `write_file`, `shell`…

What if the tools aren't ours to write? A company Jira, a home-grown deploy system, a knowledge base — you can't rewrite each one into the harness.

s19 MCP Servers → bolt an "external tool bridge" onto the agent: any service that implements the standard protocol plugs in, and the agent never needs to know who wrote it.

<details>
<summary>Into the Codex source</summary>

> The following is based on the official [Worktrees](https://developers.openai.com/codex/app/worktrees) docs, the CLI's `-C` / experimental `--worktree`, and what s23 already says about Codex Cloud. The honesty bar matches s12: the product has local git worktrees; it does **not** have a model claim tool, and this is **not** a Cloud container.

**The chapter's worktree = directory isolation for local parallel sessions + teaching named branches and merge.**

<details>
<summary>1. Codex has local worktrees, not a claim API</summary>

Be explicit about what exists:

- **Codex has**: desktop-app Worktree chats (default dir `$CODEX_HOME/worktrees`, default **detached HEAD**), Handoff (Local ↔ Worktree), scheduled tasks that can run on a background worktree, `.worktreeinclude` to copy ignored local files. The durable CLI path is `git worktree add` then `codex -C <dir>`; 0.154+ adds experimental `--worktree` / `/worktree` (enable with `codex features enable worktrees`).
- **Codex does not have**: model tools `create_worktree` / `keep_worktree`, workers claiming then creating a directory, automatic `merge` into `main`, or "this is a Cloud container".
- **This chapter adds**: root creates named branches `wt/t1` and `wt/t2`, two workers `write_file` in parallel, then `merge --no-ff` / `merge --abort` so the deferred conflict is visible.

The model only ever sees its own cwd. The worktree is **chosen by the harness when the session starts**, not by a tool call.

</details>

<details>
<summary>2. Directory isolation is not Cloud environment isolation</summary>

The chapter uses `git worktree` for **directory-level** isolation: several working trees share one `.git`, one machine, one filesystem. That is already enough to stop "the same path overwriting itself".

Codex Cloud (s23) goes further — each task runs in **its own isolated execution environment** (a container / micro-VM), with separate filesystem, process space and network. The artifact is a diff / PR; the remote is `codex cloud` / `codex apply`. The internals are not in open-source `codex-rs`. Do **not** call `git worktree add` Cloud.

s04's `workspace-write` is scoped to the **current cwd**. Two worktrees plus the sandbox cannot write into each other — that is sandbox's job, and this chapter does not restack it.

</details>

<details>
<summary>3. The teaching merge is not the product exit</summary>

After the App finishes, a person can keep verifying in the worktree, Create branch here, Handoff back to Local, or open a PR. Experimental CLI worktrees also leave the checkout for a human. **None of that** auto-merges into `main`.

The chapter's "merge succeeds → clean up / conflict → `merge --abort` and keep the branch" exists so "conflict is deferred until you hand the work back" is visible. The semantics compare to "a human decides"; do not claim Codex ships an auto-merge pipeline.

</details>

<details>
<summary>4. Lifecycle corners are out of scope</summary>

The App keeps about the most recent 15 managed worktrees by default, deletes on archive, and snapshots first. Handoff has to deal with "the same branch cannot be checked out in two places". Orphan worktrees, `git worktree prune`, path-traversal checks, refusing to delete with uncommitted changes — real implementations handle those; the chapter skips them.

The claim race is s17, the mailbox is s16, Cloud containers are s23. None of those are stacked here.

</details>

**In one line**: Codex uses git worktrees to give local parallel sessions a disjoint piece of ground; this chapter adds "same path, two contents, conflict deferred until merge surfaces it honestly". Cloud containers are s23.

</details>

<!-- translation-sync: zh@v2, en@v2 -->
