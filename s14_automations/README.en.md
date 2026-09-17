# s14: Automations — Run on Schedule, No Human Needed

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s13](../s13_background_tasks/) → [s14](../s14_automations/) → [s15](../s15_agent_teams/) → ... → s20
> *"Set the schedule, the harness runs itself"* — the scheduler sits outside the loop and drops a prompt in when due.
>
> **Harness layer**: concurrency & automation — an independent scheduler judges the time, a queue carries the trigger.

---

## The Problem

An alarm clock doesn't need you watching it to go off. You set 7:00, and it rings on its own — whether you're asleep, in the shower, or cooking.

Until now every chapter's agent has been **reactive**: you type a line, it runs one turn. s13 let a slow command yield and get harvested later, but you still kicked that turn off by hand.

Periodic work — "run the tests every morning at 9", "check the repo every 30 minutes" — shouldn't need a human to push it each time. Letting the harness decide *when* to run a turn is the mechanism this chapter adds.

---

## The Solution

![Automations](images/automations.svg)

Real Codex keeps this **outside the agent loop**. The open-source CLI has **no** built-in alarm clock — it only offers the headless entry point `codex exec`. The actual scheduler lives in the **Codex App**: an `automation.toml` plus a local scheduler that, when due, hands a prompt back to the same loop. There are two kinds; the chapter runs both:

| kind | what the real App does | what this chapter shows |
|------|------------------------|-------------------------|
| `cron` | starts a fresh turn (like one `codex exec`); findings go to the **inbox / Triage** | a new `[Scheduled]` user message + inbox |
| `heartbeat` | appends the prompt to the **same thread** and continues with old context | append `[Heartbeat]` onto `heartbeatThread` and run another turn |

On every tick the scheduler does one thing: **enqueue** every due automation. A dispatcher pops when the agent is idle and, by kind, either starts a new turn or resumes the old thread. Trigger and execution are decoupled by the queue.

> The teaching version uses a **simulated clock** (one minute per tick) and five-field cron as a stand-in for real RRULE, so the demo finishes in seconds. Swap in a real clock + RRULE and you have the App scheduler.

---

## How It Works

Four pieces: due-time matching, the scheduler (producer), the two dispatch paths, and the unchanged agent loop.

**Step 1**: due-time matching. The real App stores an RFC 5545 `rrule` (`FREQ=DAILY;BYHOUR=9;BYMINUTE=0`). This chapter uses five-field cron as the smallest stand-in; the semantics are still "should it fire this minute?"

```ts
function cronFieldMatches(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    if (part === "*") return true;
    const step = /^(\*)\/(\d+)$/.exec(part);
    if (step && value % Number(step[2]) === 0) return true;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range && value >= Number(range[1]) && value <= Number(range[2])) return true;
    if (/^\d+$/.test(part) && value === Number(part)) return true;
  }
  return false;
}
```

**Step 2**: each automation has a `kind`. `cron` starts from zero every time; `heartbeat` hangs off a living thread. `lastRunAt` is the App scheduler DB's `last_run_at`: never fire twice in the same minute.

```ts
type Kind = "cron" | "heartbeat";
type Automation = {
  id: string; kind: Kind; cron: string; prompt: string;
  recurring: boolean; lastRunAt?: string;
};
```

**Step 3**: the scheduler is the producer. Each tick **enqueues** every automation that fires — it never runs anything itself. A one-shot is deregistered after firing (RRULE `COUNT=1` in the real App).

```ts
tick(now: SimTime): void {
  const marker = `${now.hour}:${now.minute}@${now.dom}`;
  for (const a of [...this.automations.values()]) {
    if (!cronMatches(a.cron, now) || a.lastRunAt === marker) continue;
    a.lastRunAt = marker;
    firedQueue.push({ ...a });            // enqueue only, never run
    if (!a.recurring) this.automations.delete(a.id);
  }
}
```

**Step 4**: the dispatcher branches on kind. `cron` opens a fresh input array and writes the result to the inbox; `heartbeat` appends the prompt onto the same thread. Both call s01's loop.

```ts
if (job.kind === "heartbeat") {
  heartbeatThread.push({ role: "user", content: `[Heartbeat] ${job.prompt}` });
  await runTurn(heartbeatThread, job);
} else {
  const fresh = [{ role: "user", content: `[Scheduled] ${job.prompt}` }];
  const text = await runTurn(fresh, job);
  inbox.push({ id: job.id, at: job.lastRunAt ?? "", text });
}
```

**Core insight**: the agent loop does not watch a clock. An alarm (the App scheduler, OS cron, CI, Cloud) sits outside and, when it rings, does one thing — drop a user message into the loop. `cron` drops a blank page; `heartbeat` drops "go back to that conversation." The queue means the scheduler never waits for the agent to finish.

---

## Try It

> **Teaching demo note**: the offline demo runs read-only shell commands (`git status`, etc.). Run it in a scratch directory; the real approval + sandbox system is s03/s04.

**No API key needed**: this chapter is a **self-running demo** with no REPL. Without `OPENAI_API_KEY` a built-in offline model walks the whole "due → enqueue → `cron` to inbox / `heartbeat` resumes the thread" path.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s14_automations/code.ts                # offline demo model
OPENAI_API_KEY=sk-... npx tsx s14_automations/code.ts   # real model
```

Try these tweaks:

1. Change a `cron` expression to `"* * * * *"` and watch every tick start a fresh turn and grow the inbox.
2. Fire `watch` more often and watch the same `heartbeatThread` get longer, rather than starting from zero each time.
3. Run with a real key and watch how the model picks a command for "check the repo status".

Watch for: the scheduler only enqueues and never executes; `cron` results land in the inbox; `heartbeat` always appends to the same thread.

---

## What's Next

Now the harness can drop a prompt into the loop on a schedule. But many tasks are too big for one: "refactor the whole backend" spans auth, the database, routing and tests — more detail than one context window holds.

s15 Agent Teams → root uses `spawn_agent` to start named children with their own contexts, then they hand off over an in-process mailbox (`send_message` / `wait_agent`) instead of stuffing every detail into one window.

<details>
<summary>Into the Codex source</summary>

> The following is based on OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`, Rust), Codex App Automations, and the official [Automations](https://developers.openai.com/codex/app/automations) docs. This chapter matches the **App scheduler**'s model-facing slice, not "a cron hidden inside the CLI."

**This chapter ≈ one due firing of a Codex App automation.** Each item below maps to a real entry point.

<details>
<summary>1. The open-source CLI has no scheduler, only `codex exec`</summary>

`codex-rs` does not run cron inside the agent loop. The headless entry point is **`codex exec`**: give it a prompt, it runs one turn to completion, prints an event stream to stdout, and exits. To run that on a schedule locally you wire system `cron` / `systemd timer` / GitHub Actions to that command. The CLI has **no** Scheduled management UI — the official docs say creating and reviewing scheduled tasks happens in ChatGPT / the Codex App.

</details>

<details>
<summary>2. App Automations: automation.toml + a local scheduler DB</summary>

The desktop App is where the alarm clock lives. Definitions sit in `~/.codex/automations/<id>/automation.toml`; scheduler state is in a local SQLite DB (`next_run_at`, `last_run_at`, `automation_runs`). The cadence is an **RFC 5545 RRULE**, not five-field cron; the UI may let you type cron, but what is stored is still `rrule`. A local task needs the machine on, the App running, and the project still on disk. The chapter's five-field cron + `lastRunAt` is the smallest stand-in for that due / idempotent path; process memory stands in for toml + sqlite and is gone on exit.

</details>

<details>
<summary>3. Two kinds: cron starts a fresh turn, heartbeat returns to the same thread</summary>

Real `kind = "cron"` (standalone): each firing opens a new thread / a `codex exec`-style run; findings go to the **inbox / Triage**, and a run with nothing to report is archived. It can run in the project directory or an isolated worktree (s18). `kind = "heartbeat"`: the prompt is appended to the conversation at `target_thread_id`, keeping old context — the right shape for "watch this PR / wait for this build." The chapter's `inbox` and `heartbeatThread` are those two paths. In the App the model creates/updates these with `automation_update`; this chapter `register`s them in `main()` so the focus stays on "what happens when they fire."

</details>

<details>
<summary>4. Cloud and event sources are a different door, not CLI cron</summary>

**Codex Cloud** (`codex cloud exec`) runs the **same loop** in a hosted environment (s23). It is not the App's local scheduler moved to the cloud. ChatGPT web also has **app-event** scheduled tasks (Gmail / Slack / GitHub) — the docs say the desktop App, CLI, and IDE extension do not have that door. Those are the same idea as OS cron: an external trigger calls the loop when something happens. This chapter only demos time as a trigger; the consumer (dispatcher) would not have to change to accept another event source.

</details>

<details>
<summary>5. Unattended runs still pass approval and sandbox</summary>

Scheduled tasks run under your sandbox. When org policy allows it, the App uses `approval_policy = "never"` (nobody is there to type y/n). This chapter reduces approval/sandbox to a read-only shell string match; a real landing still goes through s03/s04.

</details>

**In one line**: the heart of an automation isn't "can run a task" — s01 already could — but "**the alarm clock sits outside the loop**." The CLI contributes `codex exec`; the App contributes RRULE scheduling plus the `cron` / `heartbeat` ways of dropping a prompt in. This chapter runs both drop-in styles behind one queue.

</details>

<!-- translation-sync: zh@v2, en@v2 -->
