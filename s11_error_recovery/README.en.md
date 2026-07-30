# s11: Error Recovery — An Error Is Not a Crash, It's a Classified Next Step

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s10](../s10_instructions/) → `s11` → [s12](../s12_task_system/) → `s13` → ... → s20
> *"An error is not a crash, it's a classified next step"* — back off on rate limits, compact on overflow, stop on abort.
>
> **Harness layer**: planning — when the main loop hits a failure, classify it first, then decide how to recover.

---

## The Problem

Halfway through a run, the model call throws:

```
Error: 429 Too Many Requests
```

s01's naive loop has no protection around `callModel()` — one thrown exception and the whole turn crashes. No retry, no compaction, no distinction between "wait a second and it'll be fine" and "genuinely hopeless."

But in production, API errors are the **norm**, not the exception: rate limits (429), overload (529), context overflow (413 / too long), the user hitting Esc to abort. The **correct reaction to each is completely different** — back off and retry on rate limits, compact then retry on overflow, stop immediately on abort. Treating them all as the same "crash" is like a car that stalls at every speed bump.

The problem isn't that the model is unstable — it's that **the harness treats "the call failed" as the end**. What it needs is a lookup table from "error" to "recovery path."

---

## The Solution

![Error Recovery](images/error-recovery.svg)

s01's loop stays untouched; we just wrap `callModel()` in a layer of **classified retry**. The moment the model call throws, the error goes into `classifyError()` to be bucketed, and each bucket picks a recovery path. On recovery we `continue` back to the top of the loop and retry:

| error kind | trigger signal | recovery action |
|------------|----------------|-----------------|
| `rate_limit` | HTTP 429 / 529, "rate limit", "overloaded" | exponential backoff + jitter, retry up to N times |
| `context_overflow` | HTTP 413, "context length", "too long" | reactive compaction (drop oldest turns), retry **once** |
| `abort` | user Esc / `AbortError` | abort the current turn immediately, no retry |
| `unknown` | everything else | retry a couple of times, then give up |

The key insight: **the recovery strategy is a function of the error kind**. The same `try/catch` should wait on a 429, compact on a 413, and stop on an abort — if you can't tell those three apart, you don't get to call it robust. The backoff formula is the standard `min(500 × 2^attempt, 32s)` plus 0–25% random jitter, so a fleet of concurrent requests don't all retry at the same instant.

---

## How It Works

Add one wrapper on top of s01's loop, step by step:

**Step 1**: write a classifier that maps any exception to one of four buckets, using HTTP status, error code, error name, and message text.

```ts
type ErrKind = "rate_limit" | "context_overflow" | "abort" | "unknown";

function classifyError(err: unknown): ErrKind {
  const e = err as { status?: number; code?: string; name?: string; message?: string };
  const msg = (e?.message ?? "").toLowerCase();
  if (e?.name === "AbortError" || msg.includes("abort")) return "abort";
  if (e?.status === 429 || e?.status === 529 || msg.includes("rate limit")) return "rate_limit";
  if (e?.status === 413 || e?.code === "context_length_exceeded" || msg.includes("too long"))
    return "context_overflow";
  return "unknown";
}
```

**Step 2**: prepare two recovery tools — an exponential-backoff timer, and a minimal reactive compaction (drop the oldest turns to free up context; s08 covers full auto-compaction).

```ts
function backoffDelay(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 32_000); // cap at 32s
  return base + Math.random() * base * 0.25;         // add 0–25% jitter
}

function compactThread(input: unknown[], keepRecent = 3): void {
  const tail = input.slice(-keepRecent);
  input.length = 0;
  input.push({ role: "user", content: "[compacted] earlier turns summarized" }, ...tail);
}
```

**Step 3**: write the wrapper. Inside is a `for (;;)` that first tries the model call; on a throw it classifies, and per bucket decides to `continue` (retry) or `throw` (give up / abort). Each bucket gets its own counter.

```ts
async function callModelWithRecovery(input: unknown[]): Promise<OutputItem[]> {
  let rateLimitRetries = 0, unknownRetries = 0, compacted = false;
  for (;;) {
    try {
      return await callModel(input);            // success: return right away
    } catch (err) {
      switch (classifyError(err)) {
        case "abort":    throw err;             // abort: rethrow immediately
        case "rate_limit":
          if (rateLimitRetries++ < 5) { await sleep(backoffDelay(rateLimitRetries)); continue; }
          break;
        case "context_overflow":
          if (!compacted) { compacted = true; compactThread(input); continue; }
          break;
        default:
          if (unknownRetries++ < 2) { await sleep(backoffDelay(unknownRetries)); continue; }
      }
      throw err;                                // out of options: give up
    }
  }
}
```

**Step 4**: the loop itself is identical to s01; the only change is swapping the raw call for the wrapped one.

```ts
const output = await callModelWithRecovery(input); // ← s11: wrapped, not raw
```

**Core insight**: error recovery doesn't change the agent's *shape* — the loop is the same loop, the tools are the same tools. It just turns "call the model" from a one-shot success-or-die operation into a *recoverable attempt*. In the offline demo, the scripted model is set up to **fail three times first** (429 → 529 → context overflow), so you can watch all three recovery paths run, and only on the fourth attempt does it actually get through, run the tool, and wrap up.

---

## Try It

> **Teaching demo note**: the code runs shell commands the model generates (`ls -la` in the offline demo). Run it in a scratch directory.

**No API key needed**: without `OPENAI_API_KEY`, the chapter's offline scripted model **deliberately fails three times first** (rate limit, overload, context overflow), running every recovery path in full before it finally succeeds.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s11_error_recovery/code.ts                # offline demo model
OPENAI_API_KEY=sk-... npx tsx s11_error_recovery/code.ts   # real model
```

Try these prompts:

1. `list the files in this directory`
2. `show the current git branch`
3. `create hello.ts that prints "hi"`

Watch for: do the first three model calls trigger rate-limit backoff (with growing gaps), overload backoff, and "reactive compact then retry" respectively? Watch the `[recovery]` logs for the different path each error takes, and note which early turns get dropped during compaction.

---

## What's Next

The agent now survives failure. But it still handles *one-shot* tasks — you give it a goal, it does it, done. A real project has to be broken into a pile of **interdependent** sub-tasks: set up the database before you can write the API, write the API before you can test it.

s12 Task System → give the agent a **shared task board**: create, claim, and complete tasks, declare dependencies, and block work that isn't ready yet. This is also the foundation for the multi-agent collaboration that comes later.

<details>
<summary>Into the Codex source</summary>

> The following is based on the overall structure of OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`, written in Rust). The chapter's "classify + retry" is the minimal skeleton of how Codex handles model-call failures; every difference is production-grade streaming detail and state management.

**The chapter's `callModelWithRecovery` ≈ the failure handling in Codex's model client and turn loop.** Each item below hardens that core.

<details>
<summary>1. Backoff retry lives in the model-client layer, not the turn loop</summary>

The chapter wraps retry directly around `callModel()`, glued to the loop. In Codex these two layers are separate: the low-level **model client** (the part of `core` that opens the streaming connection to the Responses API) retries transient HTTP errors (429, 5xx) with **jittered exponential backoff** on its own, and only surfaces an error to the turn loop once retries are exhausted. So "back off on rate limit" is transparent to the layer above — it sees either a successful event stream or an error that has already been retried N times. The chapter flattens this into one layer so the "classify → act" chain is visible at a glance.

</details>

<details>
<summary>2. Context overflow maps to auto-compaction, not just dropping turns</summary>

The chapter's `compactThread` is blunt: it just drops the oldest turns. Codex instead does **compaction**: when the conversation approaches the model's context window, it has the model **summarize** the earlier history into one compact item, replaces the original history with that summary, and continues (that's exactly the subject of s08). An API "prompt too long / context overflow" is one signal that triggers this path, but more often the harness compacts **proactively** based on token usage, before ever hitting the limit. The chapter uses "drop oldest turns" to simulate the "free up context" effect; mechanically it's the same "compact, then retry" road.

</details>

<details>
<summary>3. Abort is first-class and takes a completely different path from errors</summary>

The chapter buckets `abort` separately and rethrows it immediately to stop the current turn. Codex likewise strictly separates a **user interrupt** (Esc in the TUI) from a genuine **error**: an interrupt winds the current turn down cleanly — stopping the running model stream and tool execution — while **keeping the session alive**, so the user can immediately send the next instruction. It is never a candidate for retry, because retrying something the user just cancelled is meaningless. That's exactly why the chapter's `abort` branch is a `throw`, not a `continue`.

</details>

<details>
<summary>4. Streaming makes "when is it a failure" subtler</summary>

The chapter treats a model call as a single "returns or throws" unit. Codex is **streaming**: the model emits events as it generates and the harness dispatches tools as they arrive. So a "failure" can happen mid-stream — the connection drops, an event errors. The client has to decide whether the stream "produced enough to resume from" or "must be restarted wholesale," which is finer-grained than the chapter's whole-call retry. But the **recovery philosophy is identical**: classify the failure first, then pick the cheapest recovery path for each class.

</details>

**In one line**: Codex's error recovery is, at its core, the chapter's "error kind → recovery action" lookup table. Every extra mechanism — layered retries, auto-compaction, separating interrupts from the session, stream resumption — exists to make that table robust and unobtrusive in a real streaming, long-session environment. Master "classification decides recovery" first; the rest is engineering hardening.

</details>

<!-- translation-sync: zh@v1, en@v1 -->
