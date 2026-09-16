# s13: Background Tasks — Yield the Slow Command, the Agent Doesn't Wait

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s12](../s12_task_system/) → `s13` → [s14](../s14_automations/) → `s15` → ... → s20
> *"Yield the slow command, keep reasoning, harvest later"* — wait one yield window; if it is still running, return a session_id and harvest on a later turn.
>
> **Harness layer**: concurrency & automation — asynchronous execution that doesn't block the main loop.

---

## The Problem

Ever used a washing machine? You toss the clothes in, press start, and go cook dinner or answer messages — 30 minutes later it beeps to tell you it's done. You don't stand in front of it waiting.

The agent's `shell` tool is the same. `npm install` takes minutes; `npm run build` takes tens of seconds. The moment one of these runs, the loop is stuck inside `execSync`, unable to do anything else.

Reading a file is milliseconds — no waiting. `git status` returns in a second — no waiting. But `npm install`? Minutes. The agent sits idle for minutes while the model is billed by the token — idling is burning money.

---

## The Solution

![Background Tasks](images/background-tasks.svg)

Real Codex hands slow commands to **`unified_exec`**: `exec_command` `spawn`s a child process, then waits a **yield window** (about 10 seconds by default). If it finishes inside that window, this tool call returns the output; if it is still running, the model gets a `session_id`. Later it calls `write_stdin` (empty `chars` = poll), waits another window, and harvests new output or the final result. The loop is still s01's loop, with just these two new tools:

| tool | purpose | returns |
|------|---------|---------|
| `exec_command` | `spawn` a child, wait at most `yield_time_ms` | finished in time: output + `exit_code`; still running: `session_id` + output so far |
| `write_stdin` | wait another yield window on that `session_id` (empty `chars` = poll) | new output, or `exit_code` + harvested output |
| `shell` | run fast commands (still synchronous in this chapter; real Codex is async for every command) | output immediately |

The key point: `exec_command` **does not return an id and walk away**. It waits the yield window first — fast commands often finish in that same call; only a slow command comes back with a `session_id`. Getting "still running" is what tells the model to do something else, then `write_stdin` on a later turn. **The waiting time gets filled** instead of idled away.

At the same time the harness emits a **client** event stream (`ExecCommandBegin` / `ExecCommandEnd`). That stream is for the TUI. **It is not injected into the model context.** In the offline demo you'll see the first `exec_command` come back `still running` with `session_id: 1`, interleaved work, then a `write_stdin` that harvests `build artifacts ready`; the `[event]` lines on stdout are invisible to the model.

---

## How It Works

On top of s01's loop + s02's dispatch table, add Codex's own yield / harvest, step by step:

**Step 1**: a session table holding each background process's `session_id`, command, status, accumulated output, and how much of that output the model has already seen.

```ts
type ExecSession = {
  sessionId: number; command: string; status: "running" | "done";
  output: string; seen: number; exitCode: number | null;
};
const sessions = new Map<number, ExecSession>();
```

**Step 2**: `exec_command` uses `spawn` to launch the child, then **waits until the yield deadline or the process exits**. The call does return — but not instantly. The wait happens inside this one tool invocation.

```ts
async function execCommand(cmd: string, yieldTimeMs: number): Promise<string> {
  const session = spawnSession(cmd);
  const start = Date.now();
  await waitYield(session, yieldTimeMs);
  return formatExecResult(session, Date.now() - start);
}
```

**Step 3**: when the window ends, a finished process returns `exit_code` and output; a live one returns `session_id`. `write_stdin` waits another window on that id and harvests output since the last snapshot. This chapter only implements empty-`chars` polls; in real Codex, non-empty `chars` are written to the process PTY.

```ts
async function writeStdin(sessionId: number, chars: string, yieldTimeMs: number): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return `Error: no such session ${sessionId}`;
  if (chars) {
    return `Error: this teaching demo only supports empty write_stdin polls; ` +
      `real Codex writes non-empty chars to the process PTY.`;
  }
  const start = Date.now();
  await waitYield(session, yieldTimeMs);
  return formatExecResult(session, Date.now() - start);
}
```

**Step 4**: register both tools into the dispatch table; the loop is unchanged. The model starts with `exec_command`, interleaves fast `shell` work, then harvests with `write_stdin`.

```ts
const DISPATCH = {
  shell: (a) => runShell(a.command),
  exec_command: (a) => execCommand(a.cmd, a.yield_time_ms),
  write_stdin: (a) => writeStdin(a.session_id, a.chars, a.yield_time_ms),
};
```

**Core insight**: a synchronous tool fuses "invoke" and "wait until exit" into one thing; `unified_exec` splits it into "how long this tool call is allowed to wait." Finish inside the yield window, and the model sees an ordinary tool result; still running when the window ends, and the model gets a handle, not a completion notice. The client event stream and the model context are two layers: the TUI can stream output live, while the model only sees a snapshot in the next `exec_command` / `write_stdin` result. If the process exits after the turn has already gone idle, real Codex also **does not** start a new inference turn on its own.

---

## Try It

> **Teaching demo note**: the offline demo's slow command is `sleep 1.5 && echo ...`, `yield_time_ms` is 400, and the foreground commands are `echo` / `sleep 2`. No real files are touched.

**No API key needed**: without `OPENAI_API_KEY`, the built-in offline model runs the whole arc — "`exec_command` still running after the yield → interleave fast work → first `write_stdin` not done → do another piece of work → second `write_stdin` harvests the output."

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s13_background_tasks/code.ts                # offline demo model
OPENAI_API_KEY=sk-... npx tsx s13_background_tasks/code.ts   # real model
```

Try these prompts:

1. `Run the build in the background and read package.json while it runs`
2. `Start the test suite in the background, then keep refactoring src`
3. `Install dependencies in the background and scaffold the app meanwhile`

Watch for: does the slow command go through `exec_command`, wait a yield window, then return a `session_id`? Is the first `write_stdin` `still running`? Are the `[event] ExecCommandBegin/End` lines client-only? Does the last `write_stdin` harvest the output?

---

## What's Next

Background tasks solve "slow operations don't block the main loop." But what if you want something done **on a schedule** — "run the tests every day at 9am," "check the service status every 5 minutes" — triggered not by you or the model right now, but automatically when the time comes?

s14 Automations → give the agent an **alarm clock**: a tiny scheduler that enqueues a task on a cron-like tick and wakes the agent to run it.

<details>
<summary>Into the Codex source</summary>

> The following is based on the overall structure of OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`, written in Rust). The chapter's tool names and semantics follow `unified_exec`: `exec_command` + `write_stdin` + `yield_time_ms`. What follows is behavior the source actually has — it does not treat the client event stream as "push to the model."

**This chapter ≈ the model-facing slice of Codex `unified_exec`.** Each item below compares them.

<details>
<summary>1. The model-facing API is exec_command / write_stdin, not an instant id</summary>

Codex's background entry point for the model is `unified_exec`: `exec_command` defaults to `yield_time_ms ≈ 10000` (first call often capped around 30 seconds), and `write_stdin` uses a shorter default yield, with empty `chars` as a background poll. If the process exits inside the window, that tool result is output + `exit_code` and there is no session; if it is still running, a `session_id` comes back and the process stays in `UnifiedExecProcessManager`. The chapter keeps those two tool names and the "wait the window, then maybe return a handle" semantics; so the demo can finish in a few seconds, the offline script shrinks the yield to 400ms.

</details>

<details>
<summary>2. EventMsg is for the client, not a continuous push to the model</summary>

Child-process output and exit become `ExecCommandBegin`, `ExecCommandOutputDelta`, and `ExecCommandEnd` on the harness's **client event stream**, which is what the TUI / `codex exec` stdout uses to show progress. That stream is not in the model context. To see more, the model has to call `write_stdin` again (or the user has to start a new turn). The chapter prints Begin/End as `[event]` lines so "stream for the UI" and "tool result for the model" stay separate; it does **not** append a completion notice into `input[]` when the process exits.

</details>

<details>
<summary>3. Completion while idle does not auto-wake the model</summary>

When the process exits, the exit watcher emits `ExecCommandEnd`. If the turn has already finished and the session is idle, stock Codex **does not** start another inference turn — the event stops at the client. The model sees the result only through a later `write_stdin`, a new user message, or a client that injects a completion message itself. Calling auto-wake-on-exit a built-in Codex behavior is inaccurate; it is an open enhancement, not shipping behavior. The chapter also does not auto-wake.

</details>

<details>
<summary>4. Codex's core is fully async; this chapter still keeps fast work on a sync shell</summary>

Codex's Rust core runs on **tokio**: every command `spawn`s a child process, and foreground vs background only differ in "await this tool call through to exit, or yield and harvest later." To make "splitting the wait" visible, the chapter leaves fast commands on `execSync` `shell` and only sends slow ones through `exec_command`. The real implementation does not split fast/slow that way, and `approval_policy` / `sandbox_mode` still gate every execution that actually runs. The chapter also skips PTY, non-empty stdin, and parallel tool calls.

</details>

**In one line**: Codex background work is a yield window + `session_id` + `write_stdin` harvest; live output rides the client event stream, not the model context. The chapter runs that same model-facing interface in TypeScript, and prints "UI event ≠ model input" on stdout on purpose.

</details>

<!-- translation-sync: zh@v2, en@v2 -->
