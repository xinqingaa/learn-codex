# s08: Context Compaction — The Window Always Fills Up, So Make Room First

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s07](../s07_skills/) → `s08` → [s09](../s09_memory_sessions/) → `s10` → ... → s20
> *"The context window always fills up — make room before it does"* — the context window always fills up, so compact the old history before it does.
>
> **Harness layer**: memory — clean memory buys you a nearly unbounded session.

---

## The Problem

The agent is running along, and then the API refuses:

```
Error: your prompt exceeded the maximum context length
```

It has a shell — the capability is there. But it read a thousand-line file, then ran dozens of commands — every user message, every tool call, every tool output piles into the `thread` array and never shrinks.

The context window is finite. Once it's full, the model can't run even one more turn. s01's naive loop has no defense against "the thread grows forever" — it assumes memory is free.

The problem isn't that the model forgets; it's that **the harness treats "remember everything" as the default**. To survive a long task, you have to make room before it fills up.

---

## The Solution

![Context Compaction](images/context-compact.svg)

s01's loop stays untouched. You add one gate **before each model call**: estimate the token count of the whole thread, and once it crosses a budget, **summarize the oldest turns into a single compact summary item**, drop the originals, keep only the current turn, then carry on as usual.

| concept | role | teaching implementation |
|---------|------|-------------------------|
| `TOKEN_BUDGET` | the approximate token ceiling | estimated as "chars ÷ 4"; crossing it triggers compaction |
| split point | where to cut old from new | just before the last `role:"user"` message |
| compact summary item | the stand-in for the old history | one user message: `[Earlier conversation compacted…]` |
| kept part | what survives verbatim | the current turn (everything after the split point) |

The key design is **choosing the split point**: scan from the back for the last user message and cut there, and you'll never split a `function_call` from its `function_call_output` — the model never sees a dangling tool result that matches no call.

---

## How It Works

Translate this into TypeScript, step by step:

**Step 1**: estimate tokens. The teaching version has no exact tokenizer, so it uses the common "chars ÷ 4" heuristic — good enough to decide "are we nearly full?".

```ts
function approxTokens(thread: unknown[]): number {
  let chars = 0;
  for (const item of thread) chars += JSON.stringify(item).length;
  return Math.ceil(chars / CHARS_PER_TOKEN); // CHARS_PER_TOKEN = 4
}
```

**Step 2**: pick the split point. Scan from the back for the last user message and cut just before it.

```ts
let split = 0;
for (let i = thread.length - 1; i >= 0; i--) {
  if ((thread[i] as { role?: string }).role === "user") { split = i; break; }
}
if (split === 0) return; // history isn't old enough to compact
```

**Step 3**: summarize the old turns into a short brief (one model call; offline it returns a scripted summary) and wrap it as a new user message.

```ts
const oldTurns = thread.slice(0, split);
const summary = await summarize(oldTurns);
const compactItem = {
  role: "user",
  content: `[Earlier conversation compacted into this summary]\n${summary}`,
};
```

**Step 4**: replace the old history with that summary item, keeping the current turn verbatim.

```ts
thread.splice(0, thread.length, compactItem, ...thread.slice(split));
```

**Step 5**: check the budget **before** each model call and compact when over it. Doing it at the turn boundary guarantees a call is never split from its output.

```ts
thread.push({ role: "user", content: query });
if (approxTokens(thread) > TOKEN_BUDGET) await compactThread(thread);
await agentLoop(thread); // the loop itself is identical to s01
```

Assembled into the full compaction function:

```ts
async function compactThread(thread: unknown[]): Promise<void> {
  let split = 0;
  for (let i = thread.length - 1; i >= 0; i--) {
    if ((thread[i] as { role?: string }).role === "user") { split = i; break; }
  }
  if (split === 0) return;                     // not old enough to compact
  const oldTurns = thread.slice(0, split);
  const summary = await summarize(oldTurns);   // one model call compresses old history
  const compactItem = {
    role: "user",
    content: `[Earlier conversation compacted into this summary]\n${summary}`,
  };
  thread.splice(0, thread.length, compactItem, ...thread.slice(split));
}
```

**Core insight**: compaction doesn't change the agent's shape — the loop is the same loop, the tools are the same tools. It only adds a "make some room" gate before "call the model". The offline demo runs several scripted "phases", each dumping a big verbose log into the thread, so you can watch the token count climb past the budget, fire `[auto-compact]`, and drop from 700+ back to double digits — while the agent keeps working, because the "past" it sees is now that summary.

---

## Try It

> **Teaching demo note**: the code runs shell commands the model generates (offline it's just a `node -e` that prints a log). Run it in a scratch directory.

**No API key needed**: without `OPENAI_API_KEY`, this chapter drives 5 scripted phases with a built-in *offline scripted model*; each phase dumps a big verbose log into the thread, so by phase two or three compaction fires and you watch `[auto-compact]` happen.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s08_context_compact/code.ts                # offline demo model
OPENAI_API_KEY=sk-... npx tsx s08_context_compact/code.ts   # real model
```

Try these experiments:

1. Just run it and watch the `[context ~N tokens / budget 700]` and `[auto-compact]` lines: which turn first crosses the budget? How far does it drop?
2. Lower `TOKEN_BUDGET` (say `300`) and see whether compaction arrives earlier and more often.
3. Set a real `OPENAI_API_KEY` and run again to see the summary a real model writes.

Watch for: after compaction the thread holds only "one summary item + the current turn", yet the agent keeps working — everything it knows about the "past" is that summary.

---

## What's Next

Compaction makes room, but it's **lossy**: "use tabs, not spaces" can degrade into "the user has a code-style preference", and once the process exits and a new session starts, even the summary is gone. Can we have a layer that doesn't lose things and can pick up across sessions?

s09 Memory & Sessions → append every turn to `.codex/rollout.jsonl`; the next `codex resume` rebuilds the exact thread from that log and continues where it left off.

<details>
<summary>Into the Codex source</summary>

> The following is based on the overall structure of OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`, written in Rust). The chapter's "estimate budget → summarize old history → replace and continue" is the minimal skeleton of Codex's auto-compaction; every difference is engineering detail about counting precision and trigger timing.

**The chapter's `compactThread` ≈ Codex's auto-compaction flow.** Each item below hardens that core.

<details>
<summary>1. The real trigger uses token counts returned by the API, not chars/4</summary>

The chapter uses the crude "chars ÷ 4" heuristic. Codex runs on the Responses API, which returns real token usage with every response, and the harness knows the current model's context window — so it can judge precisely how close it is to the ceiling and compact proactively as it approaches. The chapter uses a heuristic only because an exact tokenizer is out of scope; the logic "check usage, compact when nearly full" is identical.

</details>

<details>
<summary>2. Compaction is a "summarization turn" whose summary is written back</summary>

The chapter's `summarize()` sends the old history to the model and asks for a short brief. Codex's compaction is likewise a **dedicated summarization request**: the model condenses the conversation so far into a compact brief sufficient to continue the work, and that brief is written back into the context as a special input item, replacing the compacted original history while the session continues. Just as in the chapter, the discarded originals no longer exist in the active context — the model's knowledge of the "past" comes from that summary.

</details>

<details>
<summary>3. Besides the automatic trigger, there's a manual `/compact`</summary>

The chapter only shows "compact automatically when over budget". Codex's TUI also offers a manual `/compact` slash command so the user can trigger the same flow whenever the context feels sluggish or they want to clean up. Automatic and manual take the same "summarize → replace → continue" path; only the trigger differs — one is fired by the harness based on token usage, the other by the user.

</details>

<details>
<summary>4. Why the split point matters, and why recent context is kept</summary>

The chapter deliberately splits at the "last user message" and keeps the current turn verbatim. That's because the Responses API context is an **ordered sequence of items**: a `function_call` must appear paired with its `function_call_output` for the model to make sense of it. Cutting arbitrarily in the middle can leave a dangling output with no matching call, causing an error or confusing the model. Codex's compaction likewise replaces only the "earlier history" while preserving the recent, still-in-use context, keeping tool-call pairs intact.

</details>

**In one line**: Codex's auto-compaction is, at its core, the chapter's "approach the ceiling → summarize old history into one item → replace and continue". Every extra mechanism — precise token counting, a dedicated summarization prompt, manual `/compact`, recent-context retention — exists to make that path accurate and stable across real long sessions. Internalize "lossy compaction buys an unbounded session" first; the rest is engineering hardening.

</details>

<!-- translation-sync: zh@v1, en@v1 -->
