# s17: Autonomous Agents — Watch the Board, Claim It Yourself

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s16](../s16_team_protocols/) → [s17](../s17_autonomous_agents/) → [s18](../s18_worktree_isolation/) → ... → s20
> *"Poll the board, claim it yourself"* — poll when idle, run what you win, then claim again.
>
> **Harness layer**: collaboration — no lead delegates; workers self-organize.

---

## The Problem

s16's teammates can exchange typed messages, but every task still has to be handed out by the lead: "alice does this, bob does that". With 10 unclaimed tasks on the board, the lead assigns 10 times — **the lead itself becomes the bottleneck**.

Worse, the lead doesn't actually know which teammate is free right now. It can only guess: assign to a busy teammate and the work queues up; assign to an idle one and nothing is wasted. That "who's free" information is something **each teammate knows best about itself**.

So why not push the assignment down? Let teammates watch the board, pick work, and claim it themselves — the lead only writes tasks onto the board. But the moment two idle teammates eye the same task at the same instant, a new problem appears: **how do you guarantee a task is claimed by exactly one worker?**

---

## The Solution

![Autonomous Agents](images/autonomous-agents.svg)

Take the lead out of the assignment loop. Each worker runs a three-phase loop: **WORK** (run the claimed task) → **IDLE** (poll the shared task board) → **SHUTDOWN** (exit when the board is all done). No lead assigns anything; the worker finds its own next task.

The crux is the claim step. The board exposes two operations: an **unlocked pure read** `scan()`, and an **atomic** `claim()`. The race is part of the design — two workers can absolutely `scan()` the same pending task in the same instant, so the authoritative "is it still free?" check must live **inside** `claim()`'s critical section. The loser concedes honestly and goes back to re-scan.

| concept | meaning | note |
|---------|---------|------|
| `scan()` | pure read of the board, **unlocked** | two workers may read the same pending task — the race starts here |
| `claim(id, owner)` | atomic claim: re-checks the task is still free **inside the lock**, then flips it to `in_progress` | exactly one winner in the critical section |
| race LOST | `claim` returns failure (task already taken) | concede honestly, re-`scan()` for the next one |
| dependency `blockedBy` | not claimable until its dependencies finish | t3 only opens once t1 and t2 are both `done` |

---

## How It Works

Four pieces: the claimable predicate, the unlocked read, a mutex that makes read-modify-write atomic, and the worker's own loop.

**Step 1**: what counts as "claimable"? Pending, unowned, and all dependencies done.

```ts
private claimable(t: Task): boolean {
  return (
    t.status === "pending" &&
    !t.owner &&
    t.blockedBy.every((id) => this.tasks.get(id)?.status === "done")
  );
}
```

**Step 2**: `scan()` is a pure read, deliberately unlocked. It's fast, but its result may already be **stale** — the moment you read t1 as free, another worker may be claiming it.

```ts
scan(): Task | undefined {
  return this.all().find((t) => this.claimable(t));  // stale the moment it's read
}
```

**Step 3**: a promise-chain mutex. Hanging the whole "read-check-modify-write" block on the tail of the chain guarantees only one segment runs at a time — that's the critical section.

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

**Step 4**: the atomic claim — the heart of this chapter. First a `sleep` simulates slow storage (that's the race window), then it re-checks **inside the lock** whether the task is still free. Only the worker that finds it genuinely free wins; everyone else gets an honest "you lost".

```ts
async claim(id: string, owner: string): Promise<{ ok: boolean; reason: string }> {
  await sleep(CLAIM_LATENCY_MS);              // the read-then-write gap: where races live
  return this.lock.run(() => {
    const t = this.tasks.get(id);
    if (!this.claimable(t))
      return { ok: false, reason: `already ${t.status} (owner: ${t.owner ?? "none"})` };
    t.owner = owner;
    t.status = "in_progress";                 // re-check passed inside the lock → sole winner
    return { ok: true, reason: "claimed" };
  });
}
```

Assembled into the worker's full loop:

```ts
async function worker(name: string, board: TaskBoard, scratch: string): Promise<void> {
  for (;;) {
    const task = board.scan();
    if (!task) {
      if (board.allSettled()) return;               // SHUTDOWN: the board is all done
      await sleep(POLL_MS);                          // IDLE: keep polling
      continue;
    }
    const res = await board.claim(task.id, name);
    if (!res.ok) continue;                           // race LOST → re-scan
    const result = await runTask(name, task, scratch); // WORK: run it in your own context
    await board.complete(task.id, result);           // post the result back to the board
  }
}
```

The core insight: **`scan()` gives you a lead, not a promise.** It tells you "t1 was free a moment ago", but by the time you reach for it, the world may have changed. So the only check that counts is the re-check inside `claim()`'s critical section — this is TOCTOU (time-of-check-to-time-of-use). Put the re-check inside the lock and the critical section has exactly one winner, so a **double-claim is eliminated structurally**. The loser doesn't retry the same task; it just re-scans, and the board naturally has a next one waiting.

---

## Try It

> **Teaching demo note**: the code creates an `s17-scratch-*` directory under the system temp dir (`os.tmpdir()`) and writes each task's artifact file there — it doesn't touch your project files.

**No API key needed**: this chapter is a **self-running demo** with no REPL. Without `OPENAI_API_KEY` it uses a built-in offline scripted model — alice and bob wake at the same time, both `scan()` t1, and the winner is decided inside `claim()`'s critical section; the loser moves on to claim t2, narrated throughout.

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

1. Add a third `worker("carol", ...)` to the `Promise.all` and watch three workers split the tasks.
2. Raise `CLAIM_LATENCY_MS` to `200` to widen the race window and watch more `race LOST`s.
3. Add an unblocked `t4` to the board and watch it get claimed in parallel with t1 and t2.

Watch for: when alice and bob both `scan()` t1, how does `claim()` guarantee only one wins? Does the loser actually take the next task (rather than stall or re-grab)? Is t3, blocked by t1+t2, only claimed after both are `done`?

---

## What's Next

The workers self-organize now, but they still share **one working directory**. Alice rewrites `app.txt` for her task; bob rewrites `app.txt` for his — they clobber each other, and afterwards nobody can say which line belongs to which task.

s18 Worktree Isolation → give every task its own git worktree so parallel workers edit disjoint directories without colliding. This is exactly the Codex Cloud model.

<details>
<summary>Into the Codex source</summary>

> The following is based on common multi-worker scheduling architectures, with reference to the overall design of OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`) and of Codex Cloud. The chapter's "atomic claim + self-scan" is the minimal skeleton of an autonomous worker; real implementations make the storage, locking and recovery production-grade.

**The chapter's `claim()` ≈ one atomic claim in a real scheduler.** The differences are the real shape of the "lock" and the "board".

<details>
<summary>1. In-memory mutex vs real atomic primitives</summary>

The chapter's `Mutex` is a promise chain — it holds because Node is single-threaded and the whole board lives in one process's memory. In real systems the board is usually **shared storage** (a database, files) and the workers are in different processes, even different machines, where an in-process mutex can't reach. So the "re-check inside the lock" is replaced by the storage layer's own atomic primitive: a database `UPDATE ... WHERE status='pending'` (in a transaction), a compare-and-swap, or a lockfile. The semantics are identical to the chapter's — **"re-check + set" must be a single atomic operation** — only the mechanism carrying it changes.

</details>

<details>
<summary>2. The race window: simulated here, free in the real world</summary>

The chapter uses `await sleep(CLAIM_LATENCY_MS)` to artificially widen the "gap between read and write" so you can see `race LOST` even in a small demo. A real scheduler doesn't have to act — network latency and storage round-trips naturally insert a gap between every "read it as free" and "write the claim", so TOCTOU races are the norm, not the exception. The chapter compresses that into one `sleep` to make the race **reproducible and observable**; the defense (re-check inside the critical section) is the same in both.

</details>

<details>
<summary>3. Task dispatch in Codex Cloud</summary>

In Codex Cloud a "task" runs in **its own isolated environment** (expanded in s18, next chapter), and a scheduling layer hands queued tasks to free execution slots. The chapter's "worker polls the board and atomically claims" is a minimal replay of that "queue → claim → run → report" loop: in the real system the "board" is shared task storage, the "claim" is an atomic state transition, and a "worker" is an independent execution environment that gets scheduled up. The chapter folds multiple machines and processes into two `async` workers in a single process, so you can focus on the one thing that matters — **a claim must be atomic**.

</details>

<details>
<summary>4. Dependencies and recovery</summary>

The chapter's `blockedBy` check (claimable only once all dependencies are `done`) maps to the plainest edge constraint in a task graph (the s12 task system covers that on its own). Real systems also handle the corners the chapter skips: if a worker dies mid-task, the task must be **reclaimed and redelivered** (not stuck in `in_progress` forever); a task may be designed to be claimed **at most N times**; completion events are persisted so work can resume after a crash. These are hardening layers on top of the "atomic claim" foundation — they don't change the foundation itself.

</details>

**In one line**: autonomy means pushing the "who's free" information down to each worker and backstopping concurrency with a single **atomic claim**. The chapter uses a promise chain as the critical section and a `sleep` as the race window to run the whole "scan → claim → run → report" loop in front of you; real systems just move the same semantics into shared storage and independent execution environments.

</details>

<!-- translation-sync: zh@v1, en@v1 -->
