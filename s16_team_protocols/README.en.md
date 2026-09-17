# s16: Team Protocols — Messages Need a Contract

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s15](../s15_agent_teams/) → [s16](../s16_team_protocols/) → [s17](../s17_autonomous_agents/) → ... → s20
> *"Type the message, correlate by id"* — Codex headers are `NEW_TASK` / `MESSAGE` / `FINAL_ANSWER`; the chapter adds a `replyTo` ledger.
>
> **Harness layer**: collaboration — envelopes turn loose mail into something you can reconcile.

---

## The Problem

s15's mailbox already moves text: `send_message` queues, `wait_agent` takes, and when a child exits the harness posts a `final:`. The letter is still **one sentence**. When root hands out three tasks and three results flow back from alice and bob, tone is not a correlation key.

s12's task board answers "what comes first", not "which letter answers which request". Communication and the board are different layers.

Codex itself already stamps mail that reaches the model: `NEW_TASK`, `MESSAGE`, `FINAL_ANSWER`. It does **not** correlate N in-flight requests by id — it addresses by agent path, and completion is one hop to the parent. The chapter demonstrates the ledger the source does not have.

---

## The Solution

![Team Protocols](images/team-protocols.svg)

Wrap s15's in-process `Mailbox` in a **typed envelope** `Envelope`: `{ id, from, to, kind, payload, replyTo?, triggerTurn }`. The `kind` names stay pedagogical (`request | response | broadcast`). The mapping is explicit — we do not pretend Codex uses those three names.

| teaching kind | Codex analog | `triggerTurn` | teaching extra |
|---------------|--------------|---------------|----------------|
| `request` | `NEW_TASK` / `followup_task` (wake the other agent to work) | `true` | root records the `id` in a pending ledger |
| `response` | harness-posted `FINAL_ANSWER` when the child finishes | `false` | `replyTo` points at that request |
| `broadcast` | **no such kind** | `false` | fan-out to every registered mailbox, no reply |

A **root** routes work as a `request` to a named child; when the child finishes, the harness posts a `response`; root **matches exactly** by `replyTo`. `broadcast` reaches everyone at once (kickoff / stand-down). That fan-out is a teaching extra, not a Codex protocol.

---

## How It Works

Four pieces: envelope fields, a waiter mailbox, a worker loop that dispatches by kind, and root's pending ledger.

**Step 1**: the envelope is the contract. Codex's `InterAgentCommunication` has `author` / `recipient` / `content` / `trigger_turn`. The chapter aligns with those, then adds two teaching fields: `kind` and `replyTo`.

```ts
type Envelope = {
  id: string;
  from: string;
  to: string;          // a teammate name, or "*" for a broadcast
  kind: Kind;          // teaching names, not a Codex enum
  payload: string;
  replyTo?: string;    // teaching extra: correlate a response to a request
  triggerTurn: boolean; // request = true; MESSAGE / FINAL_ANSWER = false
};
```

**Step 2**: the mailbox is still s15's waiters (deliver immediately if someone is blocked, otherwise queue), with envelopes instead of bare strings. A broadcast is copied to every registered mailbox, with no echo to the sender.

```ts
send(env: Envelope): void {
  const targets = env.kind === "broadcast" ? [...this.boxes.keys()] : [env.to];
  for (const t of targets) {
    if (t === env.from) continue;
    const pending = this.waiters.get(t);
    if (pending && pending.length > 0) pending.shift()!(env);
    else this.boxes.get(t)!.push(env);
  }
}
```

**Step 3**: the worker dispatches by `kind`. A `broadcast` is noted, no reply; a `request` gets worked. The reply is posted by the **harness** (Codex posts `FINAL_ANSWER` at child completion), plus teaching `replyTo`.

```ts
if (env.kind === "broadcast") { /* noted; stand-down exits */ continue; }
if (env.kind === "request") {
  const result = await runWork(name, env.payload, scratch);
  BUS.send({
    id: nextId("final"), from: name, to: env.from,
    kind: "response", payload: result,
    replyTo: env.id, triggerTurn: false,
  });
}
```

**Step 4**: root records each `request` in `pending` and ticks it off by `replyTo`. An unknown id is dropped — de-dup / cross-talk protection under concurrency.

```ts
async collect(total: number): Promise<void> {
  let got = 0;
  while (got < total) {
    const env = await BUS.recv(this.name, 15_000);
    if (!env || env.kind !== "response" || !env.replyTo) continue;
    const req = this.pending.get(env.replyTo);
    if (!req) continue;            // unknown id: ignore
    req.result = env.payload;
    got++;
  }
}
```

The core insight: **Codex uses a header to say what the letter is; the chapter uses `replyTo` to say which request it answers.** With three replies arriving together, there is no id to tell who answered what. Real Codex does not need this ledger: the parent usually waits on a child, and completion is one hop to the parent by agent path — not "N in-flight requests against N replies". `broadcast` is a teaching extra too — Codex has no everyone-announcement kind.

---

## Try It

> **Teaching demo note**: the code creates an `s16-team-*` scratch directory under the system temp dir (`os.tmpdir()`) and writes each section file there — it doesn't touch your project files.

**No API key needed**: this chapter is a **self-running demo** with no REPL. Without `OPENAI_API_KEY` it uses a built-in offline scripted model — root broadcasts kickoff, routes three tasks, drops a ghost `replyTo`, and collects three correlated replies, narrating throughout.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s16_team_protocols/code.ts                # offline demo model
OPENAI_API_KEY=sk-... npx tsx s16_team_protocols/code.ts   # real model
```

Try these tweaks:

1. Run with a real key and watch the model produce different `write_file` content for each section title.
2. Route one more task to bob and change `collect(3)` to `collect(4)`, then watch the ledger.
3. Delete the ghost response with `replyTo: "req_999"` and see whether the `ignored` line disappears.

Watch for: does each `response`'s `replyTo` point exactly at a `request`'s `id`? Why is an unknown id ignored? Why does a broadcast need no reply? How do the three pending requests flip from PENDING to fulfilled?

---

## What's Next

In s15–s16, root has to hand each teammate its work: "alice does this, bob does that". With 10 unclaimed tasks on the board, root assigns 10 times — and the orchestrator itself becomes the bottleneck.

What if teammates **watched the board and claimed work themselves**? Root only creates tasks; teammates discover, claim, run and report on their own.

s17 Autonomous Agents → workers scan s12's teaching board and claim atomically. Codex still parent-assigns (`spawn_agent` / `followup`); racing the board is a teaching extra. Directory isolation is s18; Cloud containers are s23 — neither is a claim API.

<details>
<summary>Into the Codex source</summary>

> The following is based on Multi-Agent V2 in OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`, written in Rust), and on the official [Subagents](https://developers.openai.com/codex/subagents) docs. The honesty bar matches s12: the source has envelope headers and `trigger_turn`; it does **not** have `replyTo` correlation across N in-flight requests, nor a `broadcast` kind. This chapter adds a ledger — it does not shrink a protocol that already lived in the source.

**The chapter's envelope = Codex `InterAgentCommunication` + the model-visible headers + a teaching `replyTo` ledger.**

<details>
<summary>1. The real envelope has neither kind nor replyTo</summary>

Codex's `InterAgentCommunication` is roughly: an optional communication `id`, `author` / `recipient` (`AgentPath`, e.g. `/root/worker`), `other_recipients`, `content`, optional `encrypted_content`, and `trigger_turn`. When the letter is rendered for the model, the plaintext header is:

- `NEW_TASK`: start a turn (initial spawn and later `followup_task` / `assign_task`), `trigger_turn = true`
- `MESSAGE`: `send_message` queued, `trigger_turn = false`, do not start a turn for an idle peer
- `FINAL_ANSWER`: the child reached a terminal state; the **harness** posts it to the parent (one hop). The child does not pick `kind: "response"`

There is no `request | response | broadcast` enum. The chapter uses those three names so "assign / reply / announce" dispatch clearly in ~200 lines. They are **not** a Codex API.

</details>

<details>
<summary>2. N-way replyTo is a teaching extra (like s12's claim_task)</summary>

Be explicit about what exists:

- **Codex has**: addressing by agent path, mailbox sequence numbers, `wait_agent` until there is an update, completion posted to the parent.
- **Codex does not have**: `replyTo`, a pending-request Map, "three in-flight requests against three replies", or "unknown id: ignore" de-dup.
- **This chapter adds**: the `pending` ledger + `replyTo`. It is not "a simplified request-response protocol copied from the source". It is one extra teaching step — concurrent assignments have to reconcile.

The product default is still root-orchestrated, watching one (or a few) children; the parent rarely needs "N request ids against N results". The demo assigns three at once on purpose, so the ledger becomes necessary.

</details>

<details>
<summary>3. broadcast is a teaching extra too</summary>

Codex completion is **one hop to the parent**, not a fan-out to the whole tree. `other_recipients` can CC others, but there is no `to: "*"`, every-mailbox, no-reply kind. The chapter's kickoff / stand-down broadcast exists so "announcement, no reply" and "request, must reply" share one envelope and contrast. Do not draw it as A2A broadcast, and do not draw it as MCP.

</details>

<details>
<summary>4. The mailbox is still in-process waiters, not a poll loop</summary>

s15 already made `Mailbox` a Map + waiters (matching tokio mpsc + seq + watch in `codex-rs`). An older teaching version polled the inbox with `sleep(20)` — that is not Codex. This chapter keeps waiters: if someone is blocked on `recv`, deliver immediately. The protocol sits on the envelope, not on a new transport.

Lifecycle tools (`list_agents` / `close_agent` / `resume_agent`) and encryption are out of scope. Claiming work is s17. Approval gating stays in s03/s04 — we do not invent a new `kind` for it.

</details>

**In one line**: Codex's protocol is headers + `trigger_turn` (what the letter is, whether to start a turn); this chapter adds a `replyTo` ledger (which request the reply answers). Both hang off the same s15 mailbox. Neither is a second loop.

</details>

<!-- translation-sync: zh@v2, en@v2 -->
