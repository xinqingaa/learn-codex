# s04: Sandbox — Approved Doesn't Mean Allowed Everywhere

[中文](README.md) · [English](README.en.md)

s01 → s02 → s03 → `s04` → [s05](../s05_plan_tool/) → ... → s20
> *"Approval decides whether to ask; the sandbox decides what you can touch"* — approval governs "should we ask"; the sandbox governs "what is reachable".
>
> **Harness layer**: execution — drawing a hard boundary at the execution layer.

---

## The Problem

s03 put an approval gate in front of tool execution, but that gate only answers "should we ask a human". The moment you press `y`, the command runs with your **full user privileges** against the **real workspace** — an approved `rm -rf /` still wipes the disk. The same is true inside the project: once approved, nothing limits which paths the process can still touch.

Without a sandbox, even "is this path inside the workspace?" has to be asked one call at a time. Under `on-request` the model pauses whenever it wants to write `../` or `/etc`, and *you* become the boundary. Tedious and risky: the boundary rests on attention, and everyone has a careless, tired, or persuadable moment.

Safety shouldn't ride on human vigilance. Path bounds have to be a machine-enforced invariant, wrapping **every** call — including the ones that look like "just editing a file in the repo".

---

## The Solution

![Sandbox](images/sandbox.svg)

Wrap dispatch in one more **sandbox** layer: intercept **every** tool call (including writes inside the workspace), work out what it wants to touch, then check it against `sandbox_mode` to allow or refuse. A refused call doesn't crash — the harness feeds an error item back to the model, which reads "out of bounds, refused" and picks another path.

The sandbox is not "enabled only outside the workspace", and it is not a shadow copy that later syncs back. Commands still write **real files**. The sandbox is a cage around that process. `workspace-write` just sets the cage's writable root to the launch directory: in-repo edits land on disk immediately; paths outside (and, in real Codex, often the network) stay unreachable. Only `danger-full-access` takes the lock off.

Codex's `sandbox_mode` has three modes — three sizes of writable scope:

| mode | can read | can write | when to use |
|------|----------|-----------|-------------|
| `read-only` | anything | every write refused | let the model only read code / review |
| `workspace-write` | anything | only inside the workspace (launch dir) | the default; day-to-day development |
| `danger-full-access` | anything | anything, no boundary | full trust, or a throwaway container |

Note: the teaching sandbox is a **userspace path check** (does the target path stay inside the workspace?). Real Codex uses OS-level isolation — Seatbelt on macOS, Landlock on Linux (see "Into the Codex source" below). The boundary idea is identical; only the enforcement moves from "an application-layer check" to "the kernel says no".

---

## How It Works

On top of s02's dispatch loop, we add just one layer: the sandbox verdict. It wraps dispatch, so it applies uniformly to every tool.

**Step 1**: is a path inside the workspace? The relative path must not start with `..` nor escape as an absolute path.

```ts
const isInside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
```

**Step 2**: the verdict for `write_file`. Under `read-only`, always refuse; under `workspace-write`, refuse only when it escapes.

```ts
if (name === "write_file") {
  const target = resolvePath(String(args.path));
  if (MODE === "read-only") return refuse("read-only sandbox: writes are disabled");
  if (!isInside(WORKSPACE, target)) return refuse(`write outside workspace: ${target}`);
  return ALLOW;
}
```

**Step 3**: `shell` has no structured path argument, so we use a teaching-grade heuristic — first guess whether it writes (`>`, `rm`, `mv`…), then scan the command's path tokens for any that point outside the workspace.

```ts
if (name === "shell") {
  const cmd = String(args.command ?? "");
  const mutates = SHELL_WRITES.some((op) => cmd.includes(op));
  if (MODE === "read-only") return mutates ? refuse("read-only sandbox: command may write") : ALLOW;
  const escape = shellTargets(cmd).find((t) => !isInside(WORKSPACE, t)); // an escaping path
  if (escape) return refuse(`command touches outside workspace: ${escape}`);
  return ALLOW;
}
```

**Step 4**: the sandbox **wraps** dispatch — intercept, decide, then (maybe) run. A refusal returns an error string that is fed back to the model as a `function_call_output`.

```ts
function sandboxedDispatch(call: OutputItem): string {
  const args = JSON.parse(call.arguments ?? "{}") as Args;
  const verdict = sandboxCheck(call, args);
  if (!verdict.ok) return `Error: blocked by sandbox_mode=${MODE}: ${verdict.reason}`;
  return TOOL_HANDLERS[call.name ?? ""]?.(args) ?? `Error: unknown tool '${call.name}'`;
}
```

**Step 5**: in the loop, run the sandbox check before executing, and print the verdict on each line (`✓ allow` / `✗ reason`).

```ts
for (const call of calls) {
  const verdict = sandboxCheck(call, JSON.parse(call.arguments ?? "{}"));
  console.log(`-> ${call.name}(...) ${verdict.ok ? "✓ allow" : "✗ " + verdict.reason}`);
  const result = sandboxedDispatch(call);   // ← the one change: dispatch behind the sandbox
  input.push({ type: "function_call_output", call_id: call.call_id, output: result });
}
```

The key insight: **approval and the sandbox sit on the same path and answer different questions. They are not "approval inside, sandbox outside".**

- Approval (s03) asks "should a human be consulted first?" — a dangerous in-workspace command like `rm -rf` often still runs inside the cage, because the path is within the writable root.
- The sandbox (this chapter) asks "what is physically reachable?" — every call, inside or out, runs in the cage; `sandbox_mode` only sizes the writable scope. Escapes are blocked by the cage, not by you clicking through paths.

In real Codex the order is: run first in the current sandbox; if more privilege is needed (escape, network) and `approval_policy` allows asking, surface approval and re-run elevated. This chapter splits the layers: an out-of-bounds call is `blocked` and fed back, with no follow-up `y/n`. To the model, a refusal is an ordinary `function_call_output`; the loop continues.

---

## Try It

> **Teaching demo note**: with an API key, the code runs tool calls the model generates (write files, run shell). Use a scratch directory so you don't touch real project files. Offline mode only writes to `.tmp/s04/` at the repo root, and it **deliberately tries** to write `../s04_outside.txt` (out of bounds; the default `workspace-write` mode blocks it). `danger-full-access` will actually create that out-of-bounds file — be careful.

**No API key needed**: without `OPENAI_API_KEY` this chapter runs a **fixed script** — it **ignores your prompt** and always demos "one turn: write `.tmp/s04/note.md` inside → read it back → write `../s04_outside.txt` → shell-write `.tmp/s04/shell.txt`", the same storyboard as the web simulator. The default is `workspace-write`: inside allowed, escape refused. Type anything; watch `sandbox:` allow / refuse.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s04_sandbox/code.ts                                   # offline script, default workspace-write
SANDBOX_MODE=read-only          npx tsx s04_sandbox/code.ts   # every write refused
SANDBOX_MODE=danger-full-access npx tsx s04_sandbox/code.ts   # no boundary (writes ../s04_outside.txt)
OPENAI_API_KEY=sk-...           npx tsx s04_sandbox/code.ts   # real model (tools follow the task)
```

With a key, try these prompts:

1. `Create a notes file in a scratch folder and read it back` (inside write + read; allowed under workspace-write)
2. `Write a file one level up, outside this directory` (out-of-bounds write; refused under workspace-write)
3. `Just list what's here` (pure read; allowed under all three modes)

Watch for: each turn prints the full `output` array. Under the three `sandbox_mode`s, which of the same calls are allowed and which refused? How does a refused call become a `function_call_output` error item fed back to the model while the loop continues? A second prompt in the same process does **not** re-run the script.

---

## What's Next

Now the agent can safely read, write and run commands inside a boundary. But given a multi-step task, it just starts working — you can't see how many steps it plans, which step it's on, or what's left.

s05 Plan Tool → give the model an `update_plan` tool so it publishes its plan as a live checklist: each step's status updates as it progresses, and you see the whole picture at a glance.

<details>
<summary>Into the Codex source</summary>

> The following is based on the overall architecture of OpenAI's open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`, written in Rust). The chapter's "path check + three modes + refusal fed back" is the minimal skeleton of Codex's sandbox mechanism; the real difference is that enforcement comes from the OS kernel, not an application-layer string check.

**The chapter's `sandbox_mode` ≈ the `sandbox_mode` in Codex's config (set in `~/.codex/config.toml` or a profile).** Here are the key points of the real implementation.

<details>
<summary>1. The three modes are a real config enum</summary>

Codex models the sandbox mode as a config enum whose semantics match the chapter's: `read-only` (read anything, every write refused), `workspace-write` (may write the workspace and temp dirs, reads are broader, and the network is usually restricted by default), and `danger-full-access` (no isolation — commands run with the user's full privileges). To keep the focus on "where the boundary is drawn", the chapter omits details like network restriction and keeps only the write boundary.

</details>

<details>
<summary>2. The real backend is the OS kernel: Seatbelt and Landlock</summary>

The chapter's `isInside()` checks paths in userspace — that's only an illustration. Codex's enforcement comes from the operating system:

| platform | mechanism | role |
|----------|-----------|------|
| macOS | **Seatbelt** (`sandbox-exec`, an SBPL profile) | kernel-level denial of out-of-scope file/network access |
| Linux | **Landlock** (an LSM) | lets even unprivileged processes impose filesystem access policy on themselves |

Before a command starts, it's wrapped in the platform's sandbox helper (`codex-rs` has per-platform seatbelt / landlock wrappers). After that, even if the command itself tries to escape, the kernel refuses it directly — rather than relying on the application to "catch it". That's why the sandbox is a *hard* boundary: it doesn't depend on the harness remembering to check.

</details>

<details>
<summary>3. The sandbox and approval are intertwined</summary>

As the s03 deep-dive noted, the two sit on the same execution path in Codex: a command is first tried inside the environment bounded by `sandbox_mode` (in-workspace writes are that same process, landing on real files — not a copy that later syncs); if it needs higher privileges (write outside the workspace, network access) and the current `approval_policy` allows asking, the harness surfaces an approval and, once granted, re-runs with elevated permissions. The chapter simplifies "try sandboxed, escalate on failure" into "the sandbox refuses outright + an error item is fed back" — same direction.

</details>

<details>
<summary>4. Patches and shell both go through the sandbox; only the danger mode turns it off</summary>

In Codex it's not just shell commands — file modifications like `apply_patch` are also constrained by the sandbox, with writes limited to the allowed writable roots. Only when you explicitly switch to `danger-full-access` (or run in an already-disposable container / cloud environment) is the sandbox disabled. The chapter's `sandboxedDispatch` wraps every tool precisely to reproduce this "no exceptions" principle.

</details>

**In one line**: Codex's sandbox is a hard boundary enforced by the OS kernel; the three `sandbox_mode`s decide where the boundary is drawn, and it works with approval to decide "can we escalate when out of scope". The chapter compresses that chain into "decide → allow/refuse → feed the refusal back" — master the boundary's responsibility first; the only real difference is that a production-grade refusal comes from the kernel, not a path-string comparison.

</details>

<!-- translation-sync: zh@v3, en@v3 -->
