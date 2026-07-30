# s20: The Full Harness — Many Mechanisms, One Loop

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s19](../s19_mcp_servers/) → [s20](../s20_full_harness/)
> *"Many mechanisms, one loop."* — tools, approval, sandbox, plan, memory, sub-agents and MCP all hang off the same loop.
>
> **Harness layer**: collaboration — folding the previous 19 chapters back into one runnable system.

---

## The Problem

Each of the last 19 chapters added exactly **one** mechanism to the loop. That's the clearest way to learn, but a real Codex agent never goes to work carrying just one.

A coding agent that works for hours needs all of these at once: a set of structured tools, an approval gate, a sandbox, a self-updating plan, sub-agents it can delegate to, an MCP bridge to external tools, and memory it can resume from.

The hard part isn't piling them together — it's seeing **where each one hangs on the loop**: which are tools inside the loop? Which are layers wrapped around dispatch? Which wrap the model call itself?

This chapter invents no new mechanism. It does one thing: treats every earlier mechanism as a composable *layer*, fits them all back onto the `for (;;)` from s01, then runs a narrated trace so you can watch each layer fire — and watch it say "no."

---

## The Solution

![Full Harness](images/full-harness.svg)

The key insight: these mechanisms do not all live on the same layer. To the loop, they come in three kinds — **tools in the registry**, **layers around dispatch**, and **a layer around the model call**. They all surround the same loop; none of them change it:

| mechanism | from | where it hangs | what it does |
|-----------|------|----------------|--------------|
| tool registry | s02 | inside the loop (dispatch core) | dispatches structured tools by name (`shell` / `write_file` / …) |
| `update_plan` | s05 | a tool in the registry | lets the model maintain a live checklist as it works |
| `spawn_subagent` | s06 | a tool in the registry | runs a child loop with a fresh context, returns only its summary |
| `mcp__docs__*` | s19 | bridged tools in the registry | exposes an external MCP server's tools as `mcp__<server>__<tool>` |
| approval | s03 | a layer around dispatch | every command passes `approval_policy`; pause for a human when needed |
| sandbox | s04 | an outer layer around dispatch | `sandbox_mode` decides whether a write may leave the workspace |
| memory / rollout | s09 | a layer around the **model call** | appends every turn to `rollout.jsonl`; `codex resume` can reload it |

So the whole harness is three concentric layers: the registry at the core, approval / sandbox wrapping dispatch, memory wrapping the model call — and in the very center, still the s01 loop.

---

## How It Works

**Step 1**: start by admitting a fact — the loop itself hasn't changed by a single line. It's the same `for (;;)` from s01; the only "seam" is that tool calls are handed to a thing called `dispatch`:

```ts
async function agentLoop(input: unknown[], isChild = false): Promise<string> {
  const model = isChild ? callChildModel : callModel;
  for (;;) {
    const output = await model(input);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) return extractText(output);   // no tool calls → done

    for (const call of calls) {
      const args = JSON.parse(call.arguments ?? "{}");
      const result = await dispatch(call.name ?? "", args);   // ← the only seam
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}
```

**Step 2**: the first kind of mechanism is just a tool in the registry. s02's registry does two things — advertise tools to the model, and dispatch them by name:

```ts
const TOOLS: FnTool[] = [];
const REGISTRY = new Map<string, Handler>();
function register(tool: FnTool, handler: Handler): void {
  TOOLS.push(tool);                 // advertised to the model
  REGISTRY.set(tool.name, handler); // dispatched by name
}
```

`update_plan` (s05), `spawn_subagent` (s06), and the MCP-bridged `mcp__docs__search` (s19) all look identical to the loop: a name plus a handler. The MCP bridge just renames a remote tool and registers it:

```ts
const bridged = fn(`mcp__${server}__${t.name}`, `(MCP:${server}) ${t.description}`, t.parameters);
register(bridged, (args) => s.call(t.name, args));
```

**Step 3**: the second kind doesn't live in the registry — it's a **layer wrapped around dispatch**. Approval (s03) and sandbox (s04) are each a higher-order function: take a dispatch, return a stronger dispatch.

```ts
type Dispatch = (name: string, args: Record<string, any>) => Promise<string>;

const withApproval = (next: Dispatch): Dispatch => async (name, args) => {
  if (classify(name, args) === "ask") {
    return "Error: approval_policy=on-request and the operator denied this command";
  }
  return next(name, args);
};

const withSandbox = (next: Dispatch): Dispatch => async (name, args) => {
  const target = writeTarget(name, args);
  if (target && !target.startsWith(WORKSPACE + path.sep)) {
    return `Error: sandbox_mode=workspace-write refused to write outside ${WORKSPACE}`;
  }
  return next(name, args);
};
```

Compose them — registry at the core, wrapped first by approval, then by sandbox (the outermost layer speaks first):

```ts
const baseDispatch: Dispatch = async (name, args) => {
  const handler = REGISTRY.get(name);
  if (!handler) return `Error: unknown tool "${name}"`;
  return handler(args);
};
const dispatch = withSandbox(withApproval(baseDispatch));
```

**Step 4**: the third kind wraps even further out — it wraps the **model call**, not dispatch. Memory (s09) is exactly that wrapper: on every turn, append the output to `rollout.jsonl` first, then hand it back to the loop.

```ts
type ModelFn = (input: unknown[]) => Promise<OutputItem[]>;
const withMemory = (next: ModelFn): ModelFn => async (input) => {
  const output = await next(input);
  fs.appendFileSync(ROLLOUT, output.map((i) => JSON.stringify(i)).join("\n") + "\n");
  return output;
};
```

So one tool call's full journey is **memory → loop → sandbox → approval → registry**, and back again. Whichever layer says "no", its error is fed back as an ordinary `function_call_output` — the loop doesn't stop, and the model thinks up the next step. That is the entire capstone: **adding a mechanism never means changing the loop; it means wrapping one more layer onto these fixed seams.**

---

## Try It

> **Teaching demo note**: this chapter builds its workspace in an isolated temp directory (the sandbox root) and writes `notes.md` and `rollout.jsonl` there — it never touches your repo. The sandbox refusing to write outside the workspace is exactly it doing its job.

**No API key needed**: without `OPENAI_API_KEY`, a scripted offline model issues just **one** tool call per turn, so the narrated trace lights up each layer exactly once — approval refuses once, the sandbox refuses once, a sub-agent runs once, MCP answers once.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run** (self-running demo, no input needed):

```sh
npx tsx s20_full_harness/code.ts                # offline scripted model — watch each layer fire
OPENAI_API_KEY=sk-... npx tsx s20_full_harness/code.ts   # real model, same layers around live output
```

Three ways to play:

1. Run the offline demo and read the narration line by line: which lines are the **loop** talking (`⚙` and the final answer), and which are the **layers** (`[approval]` / `[sandbox]` / `[plan]` / `[mcp]` / `[subagent]` / `[memory]`).
2. Set a real `OPENAI_API_KEY` and run again: the offline script is bypassed, but `dispatch`, `withMemory` and the whole layered structure wrap the live model's output unchanged.
3. Change one thing and re-run: swap the hardcoded `task` in `main()`, or tweak `classify()` / `writeTarget()`, and watch the allow/deny decisions of approval and sandbox shift.

Watch for: approval and the sandbox each say "no" once, yet the loop never stops — the error is fed back as an ordinary result and the model carries on. That is "many mechanisms, one loop."

---

## What's Next

This is the end of the book, and also a beginning: from s01 to here the code looks more and more complex, yet the core never changed. Pick any chapter's mechanism and re-run it with a real key; or point this assembled harness at your own repository and watch how the layers fire on your real tasks. Beyond that, go read the real [`openai/codex`](https://github.com/openai/codex) source — you can now recognize which chapter each layer inside it belongs to.

<details>
<summary>Into the Codex source</summary>

> The following is based on the overall structure of OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`, written in Rust). The teaching version composes mechanisms into layers with a few higher-order functions; Codex's production build writes the same layering into its core turn pipeline. The differences are engineering robustness, not architecture.

<details>
<summary>1. The loop itself: the turn loop in core</summary>

The chapter's `agentLoop` corresponds to the turn loop that drives one round in `codex-rs/core` (`run_turn` / `try_run_turn`). The difference: Codex consumes a **stream of events** — the model emits `ResponseItem`s as it generates, and the harness dispatches a tool call as soon as it's complete rather than waiting for the whole turn. But the condition matches the chapter: **whether this turn still contains a tool call** decides whether to continue. Every call the loop makes into approval, sandbox and memory hangs off the same seams as in the teaching version.

</details>

<details>
<summary>2. The dispatch pipeline ≈ Codex's tool-execution pipeline</summary>

The chapter's `withSandbox(withApproval(baseDispatch))` is a real execution pipeline in Codex: a tool call first passes `approval_policy` (`untrusted` / `on-failure` / `on-request` / `never`) — `on-request` makes the TUI pop an approval prompt and wait for a human y/n — and only then does the command run inside the sandbox backend, its output returning to the thread as a `function_call_output`. The chapter replaces the interactive prompt with a "demo auto-answers no"; the order and semantics are unchanged.

</details>

<details>
<summary>3. The sandbox backend: the chapter checks a path, the real thing uses the OS</summary>

The chapter's `withSandbox` does a single string-prefix check on `write_file`. Codex's `sandbox_mode` (`read-only` / `workspace-write` / `danger-full-access`) is enforced by **OS-level isolation**: Seatbelt on macOS (`sandbox-exec` policy), Landlock / seccomp on Linux. So the real sandbox applies to **every** exec, not just one tool, and a violation is blocked by the kernel, not by a string match. `codex-rs` additionally has an `execpolicy`-style policy layer that classifies commands into allow / prompt / deny.

</details>

<details>
<summary>4. The tool registry ≈ openai_tools + the MCP namespace</summary>

The chapter's `REGISTRY` corresponds to how Codex advertises tools to the model and dispatches them by name: `shell`, `apply_patch` and `update_plan` are built-in first-class tools (`update_plan` really exists — the model calls it to maintain a todo list that the TUI renders live); MCP tools come from the `mcp_servers` block in `~/.codex/config.toml`, are connected over stdio JSON-RPC by a connection manager, listed, and merged into the tool pool under the name `mcp__<server>__<tool>`. The chapter substitutes an in-process mock server for the stdio transport; the naming and dispatch are the same.

</details>

<details>
<summary>5. Memory / rollout ≈ RolloutRecorder and codex resume</summary>

The chapter's `withMemory` appends each turn's output to `rollout.jsonl`. Codex's rollout recorder (`RolloutRecorder`) does the same thing: it persists every `ResponseItem` to `~/.codex/sessions/.../rollout-*.jsonl`, so `codex resume` / `codex exec resume` can reload the thread and continue from the checkpoint. The chapter only appends the model's output items, where the real one also records session metadata and events — but the "persist every turn, reloadable" pattern is the same.

</details>

<details>
<summary>6. What the chapter simplified (an honest list)</summary>

To keep the demo runnable offline and focused on *layering* itself, this chapter made these simplifications:

- **Sub-agents** use an in-process child loop (fresh context, summary-only return) to demonstrate the general pattern; Codex's own sub-agent / multi-agent capabilities are still evolving, and cloud tasks isolate work with git worktrees (see s18).
- **MCP** uses an in-process mock server, dropping the stdio JSON-RPC transport; the bridging, naming and dispatch are real.
- **Approval** auto-answers instead of showing an interactive prompt; the classify and allow/deny branches are real.
- **Sandbox** only does a path-prefix check; real Seatbelt / Landlock is kernel-level and applies to every command.

All these simplifications share one principle: **the position of each layer and the loop's seams are real; the inside of each layer is swapped for a teaching version.**

</details>

**In one line**: Codex's production harness is not "another, smarter brain" — it's a mature set of concentric layers: tools at the core, approval and sandbox wrapping execution, memory wrapping the model call, and in the very center still the loop that hasn't changed since s01.

</details>

<!-- translation-sync: zh@v1, en@v1 -->
