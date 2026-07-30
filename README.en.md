# learn-codex

[中文](README.md) · [Live Docs](https://moonaiai.github.io/learn-codex/)

> Rebuild a **Codex-style coding-agent harness** in **TypeScript**, one mechanism at a time — **Part I (s01–s20)** progresses from a 30-line Agent Loop to a production-shaped multi-agent platform; **Part II (s21–s23)** goes deep on the real Codex product surface (the CLI, `config.toml`, Review/CI/Cloud).

This is not a "how to *use* Codex" tutorial. It's a course on **how a tool like Codex is built**. In Part I each chapter layers **exactly one** harness mechanism onto the previous chapter's runnable code; Part II maps those mechanisms back onto real Codex configuration and commands. Throughout, every concept is grounded in real OpenAI Codex design: the Responses API, `AGENTS.md`, `config.toml`, `approval_policy`, `sandbox_mode`, `update_plan`, skills, automations, MCP servers, worktrees, the Codex CLI, and Codex Cloud.

## Why this repo exists

GitHub already has plenty of "how to use Codex" guides (install, configure, examples). But almost none teach the *underlying* agent architecture the way [`learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code) does — **progressive reimplementation + runnable code + an interactive docs site**. `learn-codex` brings that format to the Codex ecosystem:

- ✅ **20-chapter progressive spine + 3 Codex-specific deep dives** — the former rebuilds the harness mechanism by mechanism, the latter masters the real Codex CLI / config / Review / Cloud
- ✅ **Every chapter runs**: `code.ts` is standalone, with a built-in **offline scripted model** so you can watch the loop work with no API key
- ✅ **Bilingual**: each chapter has `README.md` (Chinese) + `README.en.md` (English)
- ✅ **Interactive docs site**: a Next.js static site with architecture diagrams, an Agent-Loop simulator, a code viewer, and per-chapter diffs
- ✅ **Faithful to Codex**: every concept is grounded in the real open-source [`openai/codex`](https://github.com/openai/codex) (`codex-rs`, Rust)

## Learning path (23 chapters · two parts)

**Part I · Rebuild the Harness (s01–s20, 5 layers)**

### 🟦 Layer 1 · Tools & Execution
| Ch | Topic | What you build |
|----|-------|----------------|
| [s01](s01_agent_loop/) | Agent Loop | the minimal loop driving the Responses API |
| [s02](s02_tool_use/) | Tool Use | a structured tool registry & dispatcher |
| [s03](s03_approval/) | Approval | the four `approval_policy` modes |
| [s04](s04_sandbox/) | Sandbox | `sandbox_mode` + Seatbelt/Landlock isolation |

### 🟩 Layer 2 · Planning & Control
| Ch | Topic | What you build |
|----|-------|----------------|
| [s05](s05_plan_tool/) | Plan Tool | a live `update_plan` checklist |
| [s06](s06_subagents/) | Subagents | clean-context subtask delegation |
| [s07](s07_skills/) | Skills | on-demand skill loading |
| [s10](s10_instructions/) | Instructions | runtime assembly from `AGENTS.md` + `config.toml` |
| [s11](s11_error_recovery/) | Error Recovery | a classified retry strategy |

### 🟪 Layer 3 · Memory
| Ch | Topic | What you build |
|----|-------|----------------|
| [s08](s08_context_compact/) | Context Compaction | automatic context compaction |
| [s09](s09_memory_sessions/) | Memory & Sessions | rollout persistence & `resume` |

### 🟧 Layer 4 · Concurrency & Automation
| Ch | Topic | What you build |
|----|-------|----------------|
| [s13](s13_background_tasks/) | Background Tasks | async background execution |
| [s14](s14_automations/) | Automations | scheduled / triggered runs |

### 🟥 Layer 5 · Multi-Agent Platform
| Ch | Topic | What you build |
|----|-------|----------------|
| [s12](s12_task_system/) | Task System | a shared task board |
| [s15](s15_agent_teams/) | Agent Teams | teammate mailboxes |
| [s16](s16_team_protocols/) | Team Protocols | coordination message contracts |
| [s17](s17_autonomous_agents/) | Autonomous Agents | self-claiming workers |
| [s18](s18_worktree_isolation/) | Worktree Isolation | git worktree isolation (the Codex Cloud model) |
| [s19](s19_mcp_servers/) | MCP Servers | an MCP tool bridge |
| [s20](s20_full_harness/) | The Full Harness | every mechanism integrated into one loop |

**Part II · Master the Real Codex (s21–s23)**

| Ch | Topic | What you master |
|----|-------|-----------------|
| [s21](s21_codex_cli/) | The Codex CLI Surface | subcommands, slash commands, prompts, reasoning effort, search/image, auth |
| [s22](s22_config_toml/) | config.toml in Depth | providers, wire_api, sandbox_workspace_write, profiles, mcp_servers & precedence |
| [s23](s23_review_ci_cloud/) | Review, CI & Cloud | `codex review`, headless `codex exec`, CI integration, Codex Cloud tasks & PRs |

## Quick start

**Requirements**: Node.js ≥ 18 (20/22 recommended).

```sh
npm install
```

**Run any chapter** (no API key needed — uses the offline demo model):

```sh
npx tsx s01_agent_loop/code.ts
npx tsx s05_plan_tool/code.ts
# ... any sNN_*/code.ts
```

**Run against a real model** (optional): copy `.env.example` to `.env` and fill in `OPENAI_API_KEY`, or inject it inline:

```sh
OPENAI_API_KEY=sk-... npx tsx s01_agent_loop/code.ts
```

**Offline smoke-test every chapter**:

```sh
npm test
```

## Run the docs site locally

The docs site is a static Next.js app. At build time a script extracts the root chapters into JSON and renders them:

```sh
cd web
npm install
npm run dev      # → http://localhost:3000 (redirects to /en)
npm run build    # static export to web/out
```

## Repository layout

```
learn-codex/
├── s01_agent_loop/  …  s20_full_harness/   # 20 chapters (README.md / README.en.md / code.ts / images/*.svg)
├── web/                                   # Next.js interactive docs site
│   └── scripts/extract-content.ts         # build-time chapter → JSON extractor
├── scripts/run-all.ts                     # offline smoke test for all chapters
├── spec/TEMPLATE.md                       # chapter authoring spec (read before contributing)
└── .github/workflows/ci.yml               # typecheck + chapter smoke + site build
```

## Tech stack

Chapters: **TypeScript · OpenAI Responses API · tsx**. Docs site: **Next.js (App Router, static export) · React · Tailwind CSS · unified/remark/rehype**.

## Contributing

PRs welcome. Before adding or changing a chapter, read [`spec/TEMPLATE.md`](spec/TEMPLATE.md) and make sure `npx tsc --noEmit`, `npm test`, and `cd web && npm run build` all pass.

## Acknowledgements

The organization and presentation of this project are heavily inspired by [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code). All Codex concepts are grounded in OpenAI's official open-source [`openai/codex`](https://github.com/openai/codex).

## License

[MIT](LICENSE)
