# s06: Subagents — Break Big Tasks Down, Give Each a Clean Context

[中文](README.md) · [English](README.en.md)

`s01` → `s02` → `s03` → `s04` → [s05](../s05_plan_tool/) → `s06` → [s07](../s07_skills/) → ... → s20
> *"A fresh context for every digression"* — hand the side quest to a sub-agent so the main thread stays on track.
>
> **Harness layer**: planning — context isolation, so attention doesn't drift.

---

## The Problem

The agent is fixing a bug. To trace one call chain it reads thirty files and exchanges sixty turns with the main thread. The message list balloons past a hundred items, most of them "tracing the call chain" intermediate steps that have nothing to do with the actual goal — fixing the bug.

Those intermediate steps squat on context, and the agent grows increasingly "forgetful" — it can barely remember what it was supposed to fix in the first place.

Picture the human version: when you fix a bug, you **open a new terminal** to trace the call chain. When you're done, you close it, jot the conclusion in your notes, and go back to the original terminal. The agent needs the same move: spawn an independent child loop, give it an independent message list, let it focus on one thing.

---

## The Solution

![Subagents](images/subagents.svg)

Add a `task` tool: when called, the harness spawns a **sub-agent** — it has its own brand-new `input` array, runs its own agent loop, and when finished brings back **only the conclusion text**. The sub-agent's intermediate turns are discarded wholesale; only the conclusion returns to the parent thread as a `function_call_output`.

| design decision | choice | why |
|-----------------|--------|-----|
| context isolation | a fresh `input = [task]` | the child's intermediate steps never pollute the parent |
| return only the conclusion | `agentLoop` returns the final text | not the whole message list |
| no recursion | the child's tool set has no `task` | stops a child from spawning more children |
| reuse the same loop | parent and child run the same `agentLoop` | a sub-agent isn't a new mechanism — it's the loop re-entered |

A sub-agent is not a different kind of agent. It is **the same loop run again on a clean input**.

---

## How It Works

Adapt the s01 loop, step by step:

**Step 1**: make the loop return the final text (not just print it), so a sub-agent can hand its conclusion back. Distinguish parent from child with `who`; the child uses a restricted tool set.

```ts
async function agentLoop(input: unknown[], who: "parent" | "sub"): Promise<string> {
  // ...when the model stops calling tools, extract the final message text and return it
}
```

**Step 2**: the `task` tool goes only into the parent's tool list; the child doesn't get it.

```ts
const TOOLS = [SHELL_TOOL, TASK_TOOL];   // parent: can delegate
const SUB_TOOLS = [SHELL_TOOL];          // child: no task → no recursion
```

**Step 3**: the core is `spawnSubagent`. Note that the `subInput` it builds is a **brand-new array** holding only that one task — that is the "clean context".

```ts
async function spawnSubagent(description: string): Promise<string> {
  const subInput: unknown[] = [{ role: "user", content: description }]; // clean context
  const result = await agentLoop(subInput, "sub");  // its own loop, its own tools
  return result;                                    // only the conclusion returns
}
```

**Step 4**: dispatch on the tool name in the loop — `task` spawns, everything else runs as usual, and every result is fed back into the current thread.

```ts
if (call.name === "task") {
  result = await spawnSubagent(args.description);  // spawn a sub-agent
} else {
  result = runShell(args.command);                 // do it yourself
}
input.push({ type: "function_call_output", call_id: call.call_id, output: result });
```

Assembled: the parent receives a task → decides to delegate → `spawnSubagent` re-runs `agentLoop` on a clean input → the child finishes and returns a conclusion → the conclusion re-enters the parent thread as a `function_call_output` → the parent continues with it.

**Core insight**: a sub-agent's value isn't "one more model" — it's the **context boundary**. The dozens of intermediate turns of a side quest stay outside that boundary, and the main thread sees only a single conclusion. That is why attention doesn't drift.

---

## Try It

**No API key needed**: without `OPENAI_API_KEY`, the built-in offline model acts out the whole "parent delegates → child reads `package.json` in a clean context → only the conclusion returns" flow.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s06_subagents/code.ts                # offline demo model
OPENAI_API_KEY=sk-... npx tsx s06_subagents/code.ts   # real model
```

Try these prompts:

1. `Use a subtask to find out what test/build tooling this repo uses`
2. `Delegate: read the files under spec/ and summarize the authoring rules`
3. `Research how the web/ docs site is built, but keep my main thread clean`

Watch for: do `[subagent spawned]` / `[subagent done]` appear? Are the child's commands printed with a `[sub]` prefix? Does the parent only continue with the single conclusion the child returned?

---

## What's Next

The agent can split tasks now. But each task needs different **knowledge**: editing a frontend component needs React conventions, writing SQL needs the table schema. Cramming all of that into the system prompt blows up the context immediately.

s07 Skills → load skills **on demand**: instead of piling documents into the system prompt, inject the relevant instructions into the context only when needed — as naturally as reading a file.

<details>
<summary>Into the Codex source</summary>

> The following is based on the overall structure of OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`, written in Rust). The chapter's `spawnSubagent` is the minimal skeleton of "re-enter the loop on a clean input"; the real system adds session management, parallelism, and isolation on top.

**The chapter's sub-agent ≈ a fresh turn loop with its own context.** Each item below extends that core.

<details>
<summary>1. A sub-agent = the same loop, a new session context</summary>

Codex's turn loop isn't a free-floating function — it's driven by a session context that holds the conversation's history of input items. "Spawning a sub-agent" really means **constructing a new session context** (its own history, its own tool set) and letting the same turn logic run on it, rather than sharing the parent's history. The chapter's `agentLoop(subInput, "sub")` is exactly that: not one line of the loop changes — only the input and tools you feed it.

</details>

<details>
<summary>2. Narrowing the tool set is the recursion guard</summary>

The chapter forbids recursion by leaving `task` out of the child's tool list. A real system needs the same gate: a child that can spawn more children leads to unbounded nesting and resource burn. So a subtask's available tools are explicitly narrowed (drop the spawn tools, and sometimes the write-to-disk ones too). This isn't a teaching shortcut — it's standard practice in every multi-agent harness.

</details>

<details>
<summary>3. Returning only the conclusion vs. sharing intermediate state</summary>

The chapter has the child return only its final text and drops the intermediate turns. That's a deliberate simplification: in a real harness the child's **filesystem side effects** (files written, commands run) persist in the working directory — only the conversation history is thrown away. A subtask usually also needs to bubble progress, cancellation, and approval requests back up to the parent UI. The chapter sidesteps that asynchronous channel with "parent waits for the child, then takes one conclusion"; the async version is left for s13.

</details>

<details>
<summary>4. Codex Cloud: "clean context" taken to the extreme</summary>

Codex Cloud's model can be read as the sub-agent idea pushed to its limit: **every task runs in its own isolated environment** with its own clean context, undisturbed by the others (s18 on git-worktree isolation covers exactly this). The chapter's "brand-new `input` array" is the same idea in miniature, in a single process — wherever you draw the context boundary, that's how far parallelism and isolation can go.

</details>

**In one line**: a sub-agent is "the same loop + a clean input + a narrowed tool set + only the conclusion back". Real systems layer session management, async messaging, and environment isolation on top, but the trunk — "side quests don't pollute the main thread" — stays the same.

</details>

<!-- translation-sync: zh@v1, en@v1 -->
