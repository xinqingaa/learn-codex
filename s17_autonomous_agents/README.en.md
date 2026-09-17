# s17: Autonomous Agents — Watch the Board, Claim It Yourself

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s16](../s16_team_protocols/) → [s17](../s17_autonomous_agents/) → [s18](../s18_worktree_isolation/) → ... → s20
> *"Poll the board, claim it yourself"* — Codex still parent-assigns; the chapter lets workers race s12's board.
>
> **Harness layer**: collaboration — push "who's free" down to each worker, backstop concurrency with one atomic claim.

---

## The Problem

s15–s16 already move mail, but work is still pointed at by root: three `request`s, three `replyTo` replies. With 10 unclaimed tasks on the board, root assigns 10 times — **the orchestrator itself becomes the bottleneck**. It also does not know who is free right now.

Codex Multi-Agent V2 is that parent-orchestrated default: `spawn_agent` / `followup_task` / `wait_agent`. On the product surface it does not spawn unless the user explicitly asks for parallel work. CSV batch spawn still **pushes** one worker per row; workers do not **pull**.

So push assignment down? Root only writes tasks onto s12's teaching board; workers scan and claim. The moment two idle workers see the same `pending` row, a new problem appears: **how do you guarantee a task is claimed by exactly one worker?**

---

## The Solution

![Autonomous Agents](images/autonomous-agents.svg)

Each teaching worker runs a three-phase loop: **WORK** (run what it just won) → **IDLE** (poll the board) → **SHUTDOWN** (exit when the board is all done). Root no longer points at anyone.

The board exposes two operations: an unlocked pure read `scan()`, and an atomic `claim()`. The race is part of the design — both workers can `scan()` `t1` in the same instant — so "is it still free?" must live inside `claim()`'s critical section. The loser concedes honestly and scans again.

This is one extra teaching step on s12's `claim`: from "one model calls a tool" to "two loops reach at once". Codex has **no** such board, and no self-claiming workers.

| concept | meaning | note |
|---------|---------|------|
| `scan()` | pure read of the board, **unlocked** | two workers may read the same pending task |
| `claim(id, owner)` | atomic claim: re-check still free **inside the lock**, then `in_progress` | exactly one winner in the critical section |
| race LOST | `claim` fails (already taken) | re-`scan()`, do not retry the same row |
| `blockedBy` | not claimable until deps finish | t3 opens only after t1 and t2 are `done` |

---

## How It Works

Four pieces: the claimable predicate, the unlocked read, a mutex that makes read-modify-write atomic, and the worker's own loop.

**Step 1**: pending, unowned, dependencies `done`. That is s12's rule, brought forward as-is.

```ts
private claimable(t: Task): boolean {
  return (
    t.status === "pending" &&
    !t.owner &&
    t.blockedBy.every((id) => this.tasks.get(id)?.status === "done")
  );
}
```

**Step 2**: `scan()` is deliberately unlocked. Fast, and possibly already stale.

```ts
scan(): Task | undefined {
  return this.all().find((t) => this.claimable(t));  // stale the moment it's read
}
```

**Step 3**: a promise-chain mutex. The whole "re-check + set" hangs on the tail so only one segment runs at a time. This is not a Codex lockfile — it is an in-process critical section for the demo.

```ts
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
```

**Step 4**: the atomic claim. A `sleep` widens the gap between read and write (the race window), then it re-checks **inside the lock**. Only the worker that finds the row genuinely free wins.

```ts
async claim(id: string, owner: string): Promise<{ ok: boolean; reason: string }> {
  await sleep(CLAIM_LATENCY_MS);              // TOCTOU gap: where races live
  return this.lock.run(() => {
    const t = this.tasks.get(id);
    if (!this.claimable(t))
      return { ok: false, reason: `already ${t.status} (owner: ${t.owner ?? "none"})` };
    t.owner = owner;
    t.status = "in_progress";
    return { ok: true, reason: "claimed" };
  });
}
```

The worker loop:

```ts
const task = board.scan();
if (!task) { /* IDLE, or board all done → SHUTDOWN */ continue; }
const res = await board.claim(task.id, name);
if (!res.ok) continue;                         // race LOST → scan again
await runTask(name, task, scratch);            // WORK: own context
await board.complete(task.id, result);
```

The core insight: **`scan()` gives you a lead, not a promise.** The only check that counts is inside `claim()` — TOCTOU. Put the re-check in the lock and a double-claim is eliminated structurally. The loser does not retry the same row; the board already has a next one.

---

## Try It

> **Teaching demo note**: the code creates an `s17-scratch-*` directory under the system temp dir (`os.tmpdir()`) and writes task files there — it doesn't touch your project files.

**No API key needed**: a self-running demo. Root only writes t1/t2/t3; alice and bob both `scan()` t1; `claim()` picks a winner; the loser takes t2; t3 waits until both predecessors are `done`.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s17_autonomous_agents/code.ts                # offline demo model
OPENAI_API_KEY=sk-... npx tsx s17_autonomous_agents/code.ts   # real model
```

Try these tweaks:

1. Add a third `worker("carol", ...)` and watch three workers split the work.
2. Raise `CLAIM_LATENCY_MS` to `200` to widen the race window and see more `race LOST`.
3. Add an unblocked `t4` and watch it get claimed in parallel with t1 and t2.

Watch for: when both `scan()` t1, is there exactly one `claimed`? Does the loser take t2 rather than stall or re-grab t1? Is t3 claimed only after t1+t2 are `done`?

---

## What's Next

The workers self-organize now, but they still share **one working directory**. Alice rewrites `app.txt` for her task; bob rewrites `app.txt` for his — they clobber each other.

s18 Worktree Isolation → give every session its own git worktree (a local parallel checkout). Cloud container isolation is s23 — not a claim API, and not the worktree itself.

<details>
<summary>Into the Codex source</summary>

> The following is based on Multi-Agent V2 in OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`), and on the official [Subagents](https://developers.openai.com/codex/subagents) docs. The honesty bar matches s12: the source has parent-orchestrated spawn/wait; it does **not** have workers claiming a shared board. This chapter puts s12's `claim` on two concurrent loops — it does not shrink a scheduler that already lived in the source.

**The chapter's worker loop = s12 `TaskBoard` + a teaching concurrent claim. Codex still has root assign work.**

<details>
<summary>1. Codex has no pull; the product default is parent-orchestrated</summary>

Be explicit about what exists:

- **Codex has**: `spawn_agent` (returns immediately), `followup_task` / `assign_task` (`trigger_turn = true`), `send_message` (does not wake), `wait_agent`. An idle session starts a turn when mail has `trigger_turn` (or on durable sleep). CSV batch `spawn_agents_on_csv` pushes one worker per row from the orchestrator.
- **Codex does not have**: idle workers polling a shared board, `scan()`, two workers racing one `pending` row, or "you lost, scan the next one".
- **This chapter adds**: two named `worker` loops + `claim()` with a race window. They are teaching workers, **not** V2 children that claim work themselves after `spawn_agent`.

The official docs also say Codex only spawns when the user (or `AGENTS.md` / a skill) **explicitly asks** for parallel work. Pushing "who's free" down to each worker is a teaching step so TOCTOU is visible.

</details>

<details>
<summary>2. TaskBoard is still s12's teaching board</summary>

s12 already said: Codex's plan tool is `update_plan`; there is no `create_task` / `claim_task` / `owner` / `blockedBy`. This chapter does not promote the board into a Codex feature. It only lets **two loops call `claim` at once**. s15/s16 used the mailbox and never sat on this board; this is the first time multiple agents do.

The `Mutex` is an in-process promise chain. A real cross-process board would use `UPDATE ... WHERE status='pending'` or compare-and-swap. The semantics (re-check + set must be atomic) can be compared; do **not** claim `codex-rs` ships a lockfile task board.

</details>

<details>
<summary>3. Codex Cloud is not a claim API</summary>

Codex Cloud runs a task in an **isolated environment** (a container / micro-VM; see s23). The scheduler hands jobs to execution slots — cloud-side push, not agents pulling a board. CSV fan-out is still parent spawn per row; workers must `report_agent_job_result`. Still not pull. s18's git worktree is directory isolation for local parallel sessions — do not collapse it into Cloud.

The demo uses `sleep(CLAIM_LATENCY_MS)` so `race LOST` is reproducible. Real network latency supplies that gap for free; the defense (re-check inside the critical section) is analogous, but it does not come from a Codex claim tool.

</details>

<details>
<summary>4. Crash reclaim is out of scope</summary>

A worker dying mid-task, a row stuck `in_progress`, at-most-N claims, persisting completion — real schedulers handle those; the chapter skips them. Dependency edges remain s12's `blockedBy`. Mail protocols are s16. Isolated directories are s18. Neither is stacked here.

</details>

**In one line**: Codex collaboration is still parent-assigned; this chapter adds "when two hands reach at once, the claim must be atomic". `scan()` is a lead; `claim()` is the promise.

</details>

<!-- translation-sync: zh@v3, en@v3 -->
