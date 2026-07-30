# learn-codex

[English](README.en.md) · [在线文档 / Live Docs](https://moonaiai.github.io/learn-codex/)

> 用 **TypeScript** 把一个 **Codex 风格的编码 agent harness** 一个机制一个机制地重新造出来 —— **Part I（s01–s20）** 从 30 行的 Agent Loop 递进到一个生产级多智能体平台；**Part II（s21–s23）** 深挖真实 Codex 的产品面（CLI、`config.toml`、Review/CI/Cloud）。

这不是一本「怎么用 Codex」的教程，而是一门「**Codex 这样的工具是怎么造出来的**」的课。Part I 每一章都在前一章的可运行代码上叠加**恰好一个** harness 机制；Part II 则把这些机制对回真实 Codex 的配置与命令面。全程对照 OpenAI Codex 的真实设计（Responses API、`AGENTS.md`、`config.toml`、`approval_policy`、`sandbox_mode`、`update_plan`、skills、automations、MCP servers、worktrees、Codex CLI、Codex Cloud）。

## 为什么做这个仓库

GitHub 上「Codex 用法教程」已经很多（安装、配置、案例），但几乎没有一个像 [`learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code) 那样——**渐进式重造 + 可运行代码 + 交互式文档站**——来讲 agent 底层原理的项目。`learn-codex` 把这个形式带到了 Codex 生态：

- ✅ **20 章递进主线 + 3 章 Codex 专属深挖**，前者逐机制重造 harness，后者吃透真实 Codex 的 CLI / config / Review / Cloud
- ✅ **每章都可运行**：`code.ts` 独立可跑，内置**离线脚本化模型**，没有 API key 也能看清整个循环
- ✅ **中英双语**：每章 `README.md`（中文）+ `README.en.md`（English）
- ✅ **交互式文档站**：Next.js 静态站，含架构图、Agent Loop 模拟器、代码查看器、章节 diff 对比
- ✅ **忠于 Codex**：所有概念都对照真实的 `openai/codex`（`codex-rs`，Rust）讲清楚

## 学习路径（23 章 · 两部分）

**Part I · 重造 Harness（s01–s20，5 层架构）**

### 🟦 第一层 · 工具与执行
| 章 | 主题 | 你会造出什么 |
|----|------|--------------|
| [s01](s01_agent_loop/) | Agent Loop | 驱动 Responses API 的最小循环 |
| [s02](s02_tool_use/) | Tool Use | 结构化工具注册表与分发 |
| [s03](s03_approval/) | Approval | `approval_policy` 四种审批模式 |
| [s04](s04_sandbox/) | Sandbox | `sandbox_mode` + Seatbelt/Landlock 隔离 |

### 🟩 第二层 · 规划与控制
| 章 | 主题 | 你会造出什么 |
|----|------|--------------|
| [s05](s05_plan_tool/) | Plan Tool | `update_plan` 实时计划清单 |
| [s06](s06_subagents/) | Subagents | 干净上下文的子任务委派 |
| [s07](s07_skills/) | Skills | 按需加载的技能系统 |
| [s10](s10_instructions/) | Instructions | `AGENTS.md` + `config.toml` 运行时组装 |
| [s11](s11_error_recovery/) | Error Recovery | 分类重试策略 |

### 🟪 第三层 · 记忆
| 章 | 主题 | 你会造出什么 |
|----|------|--------------|
| [s08](s08_context_compact/) | Context Compaction | 上下文自动压缩 |
| [s09](s09_memory_sessions/) | Memory & Sessions | rollout 持久化与 `resume` |

### 🟧 第四层 · 并发与自动化
| 章 | 主题 | 你会造出什么 |
|----|------|--------------|
| [s13](s13_background_tasks/) | Background Tasks | 后台异步执行 |
| [s14](s14_automations/) | Automations | 定时/触发型任务 |

### 🟥 第五层 · 多智能体平台
| 章 | 主题 | 你会造出什么 |
|----|------|--------------|
| [s12](s12_task_system/) | Task System | 共享任务板 |
| [s15](s15_agent_teams/) | Agent Teams | 队友信箱 |
| [s16](s16_team_protocols/) | Team Protocols | 协作消息契约 |
| [s17](s17_autonomous_agents/) | Autonomous Agents | 自主认领任务 |
| [s18](s18_worktree_isolation/) | Worktree Isolation | git worktree 隔离（Codex Cloud 模式） |
| [s19](s19_mcp_servers/) | MCP Servers | MCP 工具桥接 |
| [s20](s20_full_harness/) | The Full Harness | 所有机制集成进一个循环 |

**Part II · 精通真实的 Codex（s21–s23）**

| 章 | 主题 | 你会吃透什么 |
|----|------|--------------|
| [s21](s21_codex_cli/) | Codex CLI 全景 | 子命令、斜杠命令、prompts、推理档位、联网/图片、登录鉴权 |
| [s22](s22_config_toml/) | config.toml 完全指南 | providers、wire_api、sandbox_workspace_write、profiles、mcp_servers 与优先级解析 |
| [s23](s23_review_ci_cloud/) | Review、CI 与 Cloud | `codex review`、无头 `codex exec`、CI 集成、Codex Cloud 任务与 PR |

## 快速开始

**环境**：Node.js ≥ 18（推荐 20/22）。

```sh
npm install
```

**运行任意章节**（无需 API key，走离线演示模型）：

```sh
npx tsx s01_agent_loop/code.ts
npx tsx s05_plan_tool/code.ts
# ... 任意 sNN_*/code.ts
```

**用真实模型跑**（可选）：复制 `.env.example` 为 `.env` 并填入 `OPENAI_API_KEY`，或直接在命令行注入：

```sh
OPENAI_API_KEY=sk-... npx tsx s01_agent_loop/code.ts
```

**离线冒烟测试全部章节**：

```sh
npm test
```

## 本地运行文档站

文档站是一个 Next.js 静态站点，构建时会用脚本把根目录的章节抽取成 JSON 再渲染：

```sh
cd web
npm install
npm run dev      # → http://localhost:3000（自动重定向到 /en）
npm run build    # 静态导出到 web/out
```

## 仓库结构

```
learn-codex/
├── s01_agent_loop/  …  s20_full_harness/   # 20 个章节（README.md / README.en.md / code.ts / images/*.svg）
├── web/                                   # Next.js 交互式文档站
│   └── scripts/extract-content.ts         # 构建期把章节抽成 JSON
├── scripts/run-all.ts                     # 全章节离线冒烟测试
├── spec/TEMPLATE.md                       # 章节作者规范（贡献前必读）
└── .github/workflows/ci.yml               # 类型检查 + 章节冒烟 + 站点构建
```

## 技术栈

章节：**TypeScript · OpenAI Responses API · tsx**。文档站：**Next.js (App Router, 静态导出) · React · Tailwind CSS · unified/remark/rehype**。

## 贡献

欢迎 PR。新增或修改章节前请阅读 [`spec/TEMPLATE.md`](spec/TEMPLATE.md)，并确保 `npx tsc --noEmit`、`npm test`、`cd web && npm run build` 全部通过。

## 致谢

本项目在组织形式与呈现方式上深受 [`shareAI-lab/learn-claude-code`](https://github.com/shareAI-lab/learn-claude-code) 启发。所有 Codex 概念均以 OpenAI 官方开源的 [`openai/codex`](https://github.com/openai/codex) 为准。

## License

[MIT](LICENSE)
