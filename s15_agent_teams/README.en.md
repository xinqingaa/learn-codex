# s15: Agent Teams — Own Contexts, Mailbox Messaging

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s14](../s14_automations/) → [s15](../s15_agent_teams/) → [s16](../s16_team_protocols/) → ... → s20
> *"Split the task across teammates, not across one context"* — `spawn_agent` returns immediately; the mailbox carries the information.
>
> **Harness layer**: collaboration — a tree of agents, each with its own context, linked by a mailbox.

---

## The Problem

"Refactor the whole backend" spans the auth module, the database layer, the API routes and the tests. While one agent is fixing the routes, the auth details have already been pushed out of its context — the window is only so big, and a single agent's attention can't cover every module.

s06's sub-agent was a temp worker: call it in, take its conclusion, throw it away. That isolates a digression (fresh context, conclusion only), but it cannot carry work that must **run in parallel, stay alive, and pass information mid-flight**. s12's task board answers "what comes first", not communication. You need teammates that communicate, work concurrently, and each keep their own context. One researches, one writes, neither crowds the other's window — they just hand over the bit the other needs.

---

## The Solution

![Agent Teams](images/agent-teams.svg)

Matching Codex **Multi-Agent V2**, this chapter adds three things: an in-process **Mailbox** (one inbox per agent), a **non-blocking `spawn_agent`** (returns a `task_name` immediately while the child runs), and **`send_message` / `wait_agent`** as ordinary tools. The teaching `root` spawns `researcher` and `writer` in the same turn; the researcher queues a one-line conclusion into the writer's mailbox; when a child exits, the harness posts a `final` to the parent mailbox, and root joins with `wait_agent`.

s06 sub-agent vs s15 teammate:

| | s06 sub-agent | s15 Multi-Agent V2 |
|---|---|---|
| spawn | `spawnSubagent`: parent `await`s until the child ends | `spawn_agent` **returns immediately**; the child runs in parallel |
| lifecycle | one-shot, destroyed after the summary | multi-turn, lives until the task is done |
| communication | returns one result | `send_message` can queue anytime; exit posts `final` |
| waiting | the spawn call itself | `wait_agent` blocks on **this** agent's mailbox |
| topology | parent waits on a child | tree: `root` + named children |

The three collaboration tools use the real Codex names:

| tool | what it does |
|---|---|
| `spawn_agent` | open a fresh context under `task_name`; do **not** wait for it |
| `send_message` | **queue** a message on the target mailbox; do **not** start a turn for them |
| `wait_agent` | block until this agent's mailbox updates (a message or a child `final`), with a timeout |

---

## How It Works

Four pieces: the mailbox, the three collaboration tools, the child loop posting `final` on exit, and root spawning in parallel then joining.

**Step 1**: the mailbox is an in-process channel. `send` appends — if the recipient is blocked on `wait_agent` the mail is handed over directly, otherwise it queues; `recv` blocks (with a timeout so a run can't hang). That is the minimal skeleton of `codex-rs`'s `Mailbox`: an in-memory queue plus a wake-up, **not** one inbox file per agent.

```ts
class Mailbox {
  private boxes = new Map<string, Mail[]>();
  private waiters = new Map<string, Array<(m: Mail) => void>>();

  send(from: string, to: string, content: string): void {
    const pending = this.waiters.get(to);
    if (pending?.length) pending.shift()!(mail);   // someone waiting → deliver now
    else this.boxes.get(to)!.push(mail);           // otherwise queue
  }

  async recv(to: string, timeoutMs = 15_000): Promise<Mail | null> {
    const box = this.boxes.get(to)!;
    if (box.length > 0) return box.shift()!;
    return new Promise((resolve) => { /* block until a message or timeout */ });
  }
}
```

**Step 2**: spawn, send and wait are ordinary Responses API function tools. Their effect is on **another agent's context**, not the filesystem. `spawn_agent` only registers the child and returns; every spawn in the same turn is registered before any child starts, so the writer's mailbox already exists.

```ts
if (name === "spawn_agent") {
  if (self !== "root") return "only the root agent can spawn";
  BUS.ensure(args.task_name);
  pendingSpawns.push({ name: args.task_name, task: args.message, parent: self });
  return `spawned ${args.task_name}`;            // return now; do not await the child
}
if (name === "send_message") { BUS.send(self, args.target, args.message); return `queued for ${args.target}`; }
if (name === "wait_agent") {
  const msg = await BUS.recv(self);               // block on our own mailbox
  return msg ? `[mailbox from ${msg.from}] ${msg.content}` : "(mailbox timeout)";
}
```

**Step 3**: each agent is still the s01 loop, holding a private `input` array. Children get a narrower tool list (no `spawn_agent`, so no recursion). When the loop ends, the harness **itself** posts `final` to the parent mailbox — Codex's `FINAL_ANSWER`, not another model-issued tool call.

```ts
async function runAgent(name, role, task, scratch) {
  const input: unknown[] = [{ role: "user", content: task }];   // private context
  for (let step = 0; step < 8; step++) {
    const output = await callModel(input, role);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) break;                             // this agent is done
    for (const c of calls) { /* dispatch tools, write results back into this input */ }
    flushSpawns(scratch);                                      // start children after this turn's spawns
  }
  const parent = parentOf.get(name);
  if (parent) BUS.send(name, parent, `final: ${closing}`);     // FINAL_ANSWER
}
```

**Step 4**: root fires both `spawn_agent` calls in one turn, then `wait_agent` twice to collect two `final`s. The researcher's raw notes never enter the writer or root windows — the only things that cross are the one-line `send_message` and the completion `final`.

```ts
// root's first turn (offline script): both spawns in the same turn
spawn_agent({ task_name: "researcher", message: "… send_message findings to writer." })
spawn_agent({ task_name: "writer",     message: "wait_agent for findings, write the doc." })
```

The core insight: **teammates share information, not a context**. `spawn_agent` turns "open another terminal" into a named parallel thread; the mailbox forces anything that crosses the boundary to be said out loud. The `researcher` can read dozens of raw notes and send only a one-line conclusion to the `writer`; root's window never holds that conclusion, only two `final`s. There is no central scheduler stepping them: send, wait, and a harness-posted completion are enough for the loops to hand off.

---

## Try It

> **Teaching demo note**: the code creates an `s15-team-*` scratch directory under the system temp dir (`os.tmpdir()`) and writes `agent-loop.md` there — it doesn't touch your project files.

**No API key needed**: this chapter is a **self-running demo** with no REPL. Without `OPENAI_API_KEY` it uses a built-in offline scripted model — `root` spawns two children in parallel and walks the full "research → send → wait → write → two finals" hand-off.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s15_agent_teams/code.ts                # offline demo model
OPENAI_API_KEY=sk-... npx tsx s15_agent_teams/code.ts   # real model
```

Try these tweaks:

1. Run with a real key and watch how `researcher` phrases that `send_message` in natural language.
2. Have `writer` `send_message` root after writing (on top of the harness `final`) and watch the extra line in root's mailbox.
3. Shrink `recv`'s `timeoutMs` and watch `(mailbox timeout)` prevent a hang.

Watch for: children print `online` right after `spawn_agent` — root did not wait for them to finish before returning; the `writer` receives just that one findings line, not the researcher's notes; root's last two mails are `final:`, posted by the harness.

---

## What's Next

Teammates can spawn and talk, but the mail is still loose natural language: one line out, one line back, with no "this reply answers that request". When root hands out three tasks and three results flow back, tone is not a correlation key.

s16 Team Protocols → wrap messages in typed envelopes (request / response / broadcast) so a lead can route work and collect results by id. That is the teaching counterpart of Codex's `NEW_TASK` / `MESSAGE` / `FINAL_ANSWER` headers, plus an id that ties one round-trip together.

<details>
<summary>Into the Codex source</summary>

> The following is based on Multi-Agent V2 in OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`, written in Rust), and on the official [Subagents](https://developers.openai.com/codex/subagents) docs. The chapter is the minimal skeleton of "named child threads + an in-process mailbox"; the real system adds lifecycle, path addressing, wake policy and session isolation.

**The chapter's root + `spawn_agent` / `send_message` / `wait_agent` ≈ Codex Multi-Agent V2.** It is not "a sub-agent plus a generic multi-agent bus" — it is Codex's own collaboration tools.

<details>
<summary>1. spawn_agent returns immediately: that is the real upgrade from s06</summary>

s06's `spawnSubagent` does `await agentLoop(subInput)` inside the parent — the parent waits until the child returns a conclusion. That chapter's tool happens to be named `task`, but it is **not** s12's task board (`create_task` / `claim_task`). Codex's `spawn_agent` (the agent tool table in `codex-rs/tools`) returns **immediately** with a canonical task name (V2 `AgentPath` values like `/root/worker`); the child runs in its own session. The parent joins with `wait_agent`. The chapter uses short names `researcher` / `writer` instead of full paths, and forbids children from spawning (narrower tool list) — the real system allows nested spawn, capped by `agents.max_concurrent_threads_per_session`.

On the product surface, current Codex spawns when the user (or `AGENTS.md` / a skill) **explicitly asks** for parallel delegation; each sub-agent burns its own tokens, so it costs more than a single-agent run. Built-in roles include `default`, `worker` and `explorer`; you can also drop TOML files under `~/.codex/agents/` or `.codex/agents/` (`name`, `description`, `developer_instructions`, plus optional `model` / `sandbox_mode`). The chapter puts the role in the prompt and does not parse TOML.

</details>

<details>
<summary>2. The mailbox is an in-process channel, not an inbox file</summary>

The real type is `Mailbox` in `codex-rs` core: a tokio `mpsc` plus a monotonic sequence and a `watch` channel, used to wake a caller blocked in `wait_agent`. Sending enqueues and bumps seq; the receiver drains. Session history persists via rollout (s09); **the mailbox itself is not** "one JSONL file per agent". The chapter's `Map` + `waiters` is that in-memory channel; it vanishes when the process exits. Drawing the mailbox as a disk file is a different multi-agent architecture, not Codex.

</details>

<details>
<summary>3. send_message does not start a turn; followup sets trigger_turn</summary>

`InterAgentCommunication` carries `author`, `recipient`, `content` and `trigger_turn`. `send_message` sets `trigger_turn` to false: the message queues and does **not** open a new turn for an idle recipient. To make them work now, the real tool surface is `followup_task` / `assign_task` (`trigger_turn = true`). An idle session starts `maybe_start_turn_for_pending_work` only when mail asks for a turn (or a durable sleep is attached).

The chapter folds "queue" and "the recipient is blocked on wait_agent, so deliver now" into one `send`: the demo's writer is waiting from the first turn, so it does not need a separate `followup_task`. The real system must keep those two deliveries apart — queued chatter should not burn a model turn.

When a message is shown to the model, V2 renders a plaintext envelope header: `NEW_TASK` (starts a turn, including the initial spawn and a later followup), `MESSAGE` (a queued `send_message`), `FINAL_ANSWER` (the child reached a terminal state). The chapter's `final:` prefix is a stand-in for `FINAL_ANSWER`; the typed `kind` / `id` / `replyTo` envelope is s16.

</details>

<details>
<summary>4. wait_agent: the chapter waits on its own mailbox; real V2 waits for "an update"</summary>

The chapter's `wait_agent` blocks on **the caller's own** mailbox, returns the full text when mail arrives, and returns `(mailbox timeout)` on timeout. That is the most direct join.

Codex V1 `wait_agent` took `targets` and waited for those children to reach a final status, which could include the last message. V2 waits for the mailbox sequence to change: the tool result is a "wait completed / timed out" summary and **does not necessarily inline the letter** — the body shows up as an envelope on the recipient's later turn. The chapter puts the body in the tool output so the offline script makes "writer got the findings" obvious. Both are "suspend without mail, wake when mail arrives"; they plug into the main event loop differently.

</details>

<details>
<summary>5. The topology is a tree; the product default is root-orchestrated</summary>

Addressing uses `AgentPath` (`/root/researcher`). `send_message` can target any still-live agent in the tree, so siblings **can** talk directly — the demo's researcher → writer is that capability. The product default remains **root orchestration**: spawn, wait, summarize; a child's `FINAL_ANSWER` is posted to its **parent** (one hop), not broadcast across the tree. When a nested grandchild completes, the grandparent does not automatically see it in `wait_agent` — the parent must keep waiting and relay. The chapter has no nesting; root collects two child `final`s and stops.

The real tool surface also has `list_agents`, `close_agent`, `resume_agent`, and optional `fork_context` / `fork_turns` (copy parent history into the child). The chapter skips lifecycle and fork, and keeps a clean new `input`. The CLI uses `/agent` to switch threads; approval prompts can bubble from a background child into the thread you are looking at.

</details>

**In one line**: a teammate = its own context + its own agent loop + a mailbox; `spawn_agent` keeps it alive in parallel, `send_message` / `wait_agent` move information without merging windows. The hard part isn't "run two loops" — it's whether the hand-off is reliable and correlatable, which is exactly what the next chapter's protocols solve.

</details>

<!-- translation-sync: zh@v2, en@v2 -->
