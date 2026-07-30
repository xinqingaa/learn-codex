# learn-codex — Chapter Authoring Spec (internal build contract)

This document is the **single source of truth** for every chapter author agent. Read it fully, then read the gold reference chapter `s01_agent_loop/` (code.ts, README.md, README.en.md, images/agent-loop.svg) before writing. Your chapters must be indistinguishable in structure and quality from s01.

## What learn-codex is

A course that teaches how a **Codex-style coding-agent harness** works by **rebuilding it one mechanism at a time**, in **TypeScript**, across 20 progressive chapters. It mirrors the pedagogy of `learn-claude-code` but every concept is re-framed around **OpenAI Codex**: the Responses API, `AGENTS.md`, `config.toml`, `approval_policy`, `sandbox_mode`, `update_plan`, skills, automations, MCP servers, worktrees.

The reader is a developer who knows TypeScript and has used (or seen) an AI coding tool. Tone: direct, insight-driven, engineering-first. Chinese is the source language; English is a faithful translation.

## Chapter folder layout (exact)

```
sNN_slug/
  README.md          # Chinese source (canonical)
  README.en.md       # English translation (same structure, same sections)
  code.ts            # standalone runnable TypeScript demo
  images/
    <slug>.svg       # ONE architecture diagram, English labels, 720x540 viewBox
```

- Folder slugs (must match exactly): `s02_tool_use`, `s03_approval`, `s04_sandbox`, `s05_plan_tool`, `s06_subagents`, `s07_skills`, `s08_context_compact`, `s09_memory_sessions`, `s10_instructions`, `s11_error_recovery`, `s12_task_system`, `s13_background_tasks`, `s14_automations`, `s15_agent_teams`, `s16_team_protocols`, `s17_autonomous_agents`, `s18_worktree_isolation`, `s19_mcp_servers`, `s20_full_harness`.
- The web extractor keys on the `sNN` prefix only; the slug is for humans and cross-links.

## README.md structure (Chinese source) — required sections, in order

1. `# sNN: <Title> — <中文 motto>`
2. Language nav line exactly: `[中文](README.md) · [English](README.en.md)` then a blank line
3. Progress line, e.g. for s05: `` `s01` → ... → [s05](../s05_plan_tool/) → [s06](../s06_subagents/) → ... → s20 `` (link prev/next by folder slug; plain `sNN` text otherwise)
4. Blockquote: an English one-line motto in italics + a Chinese gloss, then `> **Harness 层**: <层名> — <一句话>`. Layer names: s01–s04 执行; s05–s07,s10,s11 规划; s08–s09 记忆; s13–s14 并发与自动化; s12,s15–s20 协作.
5. `## 问题` — the concrete pain point, told as a story (2–4 short paragraphs).
6. `## 解决方案` — the mechanism, ONE `![alt](images/<slug>.svg)` image, and a Markdown table explaining signals/modes/options.
7. `## 工作原理` — step-by-step build-up with fenced ```ts code blocks (real excerpts from code.ts), ending with the assembled core function, then a paragraph of insight.
8. `## 试一下` — a `>` callout if the demo touches the filesystem; `npm install`; run via `npx tsx sNN_slug/code.ts`; mention the offline demo model; 3 numbered example prompts; an "观察重点" line.
9. `## 接下来` — 1 short paragraph teeing up chapter sNN+1.
10. A `<details><summary>深入 Codex 源码</summary>` deep-dive comparing the teaching version to the real `openai/codex` (`codex-rs`, Rust) implementation. Use nested `<details>` blocks. **Be honest and accurate** — describe real components (e.g. `core` turn loop, `ExecPolicy`, Seatbelt/Landlock, `mcp_servers`, rollout persistence) at an architectural level; do **not** invent fake line numbers or fake file names. Frame as "based on the open-source repo's architecture".
11. Final line: `<!-- translation-sync: zh@v1, en@v1 -->`

`README.en.md` mirrors this exactly in English (section headings: `## The Problem`, `## The Solution`, `## How It Works`, `## Try It`, `## What's Next`; deep-dive summary `Into the Codex source`).

## code.ts requirements (hard rules — CI enforces these)

- **Standalone & runnable**: `npx tsx sNN_slug/code.ts` runs start-to-finish with **no API key** and exits cleanly. It must also work against the real API when `OPENAI_API_KEY` is set.
- **Type-checks clean** under the repo `tsconfig.json` (`npx tsc --noEmit`, strict). No `// @ts-nocheck`. Prefer explicit types; `any` only where the SDK is verbose, with a comment.
- **ESM TypeScript**, `import OpenAI from "openai"`, Node built-ins via `node:` prefix.
- **Offline demo model**: reuse the s01 pattern — a `callModel()` that returns Responses-API-shaped output items, backed by `openai.responses.create` when a key exists and by a scripted `offlineModel()` otherwise. The scripted model must *meaningfully demonstrate this chapter's mechanism* (e.g. s03 shows a command being blocked pending approval; s05 shows update_plan being called). Clearly label it `[offline demo]`.
- **Progressive**: each chapter assumes the base harness (the s01 loop +, from s02 on, a tool registry) and **adds exactly one new mechanism**, marked with a `// ── NEW in sNN: <mechanism> ──` banner. Re-implement prior infrastructure inline (self-contained), keep it tight.
- **Header docstring** `/** ... */` explaining the mechanism, an ASCII diagram, and run instructions (like s01).
- **Entry point**: a `main()` REPL or a self-running demo (`main()` at the bottom). For heavier mechanisms (teams, scheduler, MCP), a scripted self-running demo that prints a narrated trace is preferred over an interactive REPL.
- Tools use the Responses API function-tool shape and are named in `"name": "..."` so the extractor can list them.
- Target **130–260 lines** (grows with chapter number; s20 may be ~350).

## SVG requirements

- ONE diagram per chapter, `viewBox="0 0 720 540"`, English labels, matches s01's visual language: light `#fafbfc` background, dark `#111827`→`#2563eb` gradient header bar with a white bold title, rounded boxes (`rx=8`), arrow markers, a footer note box. Reuse s01's `<defs>` marker/gradient pattern. Diagram **this chapter's mechanism** (e.g. s04 shows the command → sandbox policy → allowed/denied boundary).

## Codex terminology to use (be authentic)

Responses API · `reasoning.effort` (low/medium/high) · function tools · `apply_patch` · `approval_policy` = `untrusted | on-failure | on-request | never` · `sandbox_mode` = `read-only | workspace-write | danger-full-access` · Seatbelt (macOS) / Landlock (Linux) · `AGENTS.md` · `~/.codex/config.toml` · `profiles` · `model_providers` / `wire_api` · `update_plan` · skills (`~/.codex/skills`, `.agents/skills`) · auto-compaction · session rollout / `codex resume` · `codex exec` (non-interactive) · automations · `mcp_servers` · Codex Cloud / git worktrees. Cite the real repo as `openai/codex` (`codex-rs`).

## Per-chapter mechanism assignment (coverage map)

| Ch | Slug | New mechanism (the ONE thing it adds) | code.ts must demonstrate |
|----|------|----------------------------------------|---------------------------|
| s02 | tool_use | Tool registry & dispatch map | 4–5 structured tools (read_file, write_file, apply_patch, list_dir, shell) dispatched by name; parallel calls in one turn |
| s03 | approval | `approval_policy` gate before exec | a policy fn classifies each tool call; `on-request` pauses for a y/n; denied calls return an error item |
| s04 | sandbox | `sandbox_mode` exec policy | a sandbox layer that simulates read-only / workspace-write / danger-full-access; writes outside the workspace are refused; note Seatbelt/Landlock as the real backend |
| s05 | plan_tool | `update_plan` todo tool | model calls update_plan with step list + statuses; harness renders a live checklist as it works |
| s06 | subagents | Delegate a subtask to a child loop | spawn a sub-agent with a fresh context to research/summarize, result returns to parent |
| s07 | skills | On-demand skill loading | scan a `skills/` dir of `SKILL.md`; inject a skill's instructions into context only when the task matches |
| s08 | context_compact | Auto-compaction | token-budget counter; when exceeded, summarize older turns into a compact item and continue |
| s09 | memory_sessions | Rollout persistence & resume | append each turn to a `.jsonl` rollout file; on start, `--resume` reloads and continues |
| s10 | instructions | Runtime instruction assembly | build the system prompt from built-ins + `AGENTS.md` (project) + a `config.toml`-like profile |
| s11 | error_recovery | Classified retry | wrap callModel; classify errors (rate-limit, overflow, abort) and apply backoff / compact-retry / give-up |
| s12 | task_system | Shared task board | a TaskBoard (create/claim/complete) the agent reads and updates as it plans work |
| s13 | background_tasks | Async background execution | run a slow shell command in the background; model continues, harvests the result on a later turn |
| s14 | automations | Scheduled / triggered runs | a tiny scheduler that enqueues a task on a cron-like tick and runs the agent on it |
| s15 | agent_teams | Teammate mailboxes | two named agents exchange messages via mailboxes to split a task |
| s16 | team_protocols | Coordination contracts | typed message envelope (request/response/broadcast) + a lead that routes work |
| s17 | autonomous_agents | Self-claiming workers | idle agents poll the task board, claim a task, run it, post results |
| s18 | worktree_isolation | Git worktree lifecycle | create isolated git worktrees per task so parallel agents don't conflict (Codex Cloud model) |
| s19 | mcp_servers | MCP tool bridge | connect to an MCP-style server (stdio JSON-RPC), list its tools, expose them to the model, call one |
| s20 | full_harness | Integration | one loop wiring together tools+approval+sandbox+plan+memory+subagents+mcp, narrated trace |

## Quality bar

- A reader must be able to read the zh README, run the offline demo, and *understand the mechanism* without any other chapter.
- No placeholder text, no TODOs, no dead code. Every command in "试一下" must actually work.
- Chinese and English READMEs must say the same thing.
- Verify before you finish: `npx tsc --noEmit` passes and `npx tsx sNN_slug/code.ts` runs clean offline (pipe it an input like `printf 'do the thing\nq\n'`).
