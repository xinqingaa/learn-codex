# Harness 工程笔记

长文：[harness-engineering.md](./harness-engineering.md)

`agent` = `model` + `harness`。模型只产出决定；**感知、行动、执行、验证、约束**全部是 `harness` 的工作。

本目录是那份长文的入口：介绍它在讲什么，并把它的五关映射到课程的 `s01`–`s28`。

## 两张地图

- **课程**（仓库根目录）：`s01` → `s28`，一章加一个机制，按建造顺序读。
- **这篇笔记**：按一次动作的生命周期横切——感知、行动、执行、验证、约束，最后合起来。

不要用「第几部分」记这篇笔记。看到一个陌生 `agent` 系统时，问的是：感知怎么做、行动怎么翻译、执行怎么扛住失败、验证怎么问「该不该」、约束怎么限制损失。

## 怎么读

- 先要一张总图 → 读长文[开篇](./harness-engineering.md#intro)，看 `five-elements.svg` 和 `panorama.svg`
- 先要动手 → 从 [s01](../s01_agent_loop/) 顺着造，卡在某一关时用下面的表跳回长文
- 先要对照真实 `Codex` → 从 [s21](../s21_codex_cli/) 起的产品面章节，用[反查表](#reverse-index)跳到对应环节

## 五关 → 课程章节

### [感知——决定模型这一轮该看见什么](./harness-engineering.md#perceive)

| 笔记小节 | 课程 |
|---|---|
| 提示词与配置 | [s10](../s10_instructions/)、[s22](../s22_config_toml/) |
| 知识分层（目录 / 正文） | [s07](../s07_skills/) |
| 外化计划 | [s05](../s05_plan_tool/) |
| 干净上下文 | [s06](../s06_subagents/) |
| 上下文压缩 | [s08](../s08_context_compact/) |
| 会话与生命周期 | [s09](../s09_memory_sessions/)、[s28](../s28_sessions_sandbox_safety/) |

### [行动——决定意图如何变成可判定的请求](./harness-engineering.md#act)

| 笔记小节 | 课程 |
|---|---|
| 契约、注册表、结构化补丁 | [s02](../s02_tool_use/) |
| 执行位置三类 | [s25](../s25_builtin_tools/) |
| 模型后端 | [s26](../s26_local_models_providers/)、[s22](../s22_config_toml/) |
| `MCP` | [s19](../s19_mcp_servers/)、[s27](../s27_codex_service_surfaces/) |
| 打包与钩子 | [s24](../s24_plugins_apps_hooks/) |

### [执行——决定请求如何在现实世界里被跑完](./harness-engineering.md#execute)

| 笔记小节 | 课程 |
|---|---|
| 循环与只增序列 | [s01](../s01_agent_loop/) |
| `yield` 窗口 | [s13](../s13_background_tasks/) |
| 错误恢复 | [s11](../s11_error_recovery/) |
| 调度器 | [s14](../s14_automations/) |
| 无人值守 | [s23](../s23_review_ci_cloud/) |
| 协作原语 | [s15](../s15_agent_teams/)、[s16](../s16_team_protocols/) |

### [验证——决定这个动作该不该发生](./harness-engineering.md#verify)

| 笔记小节 | 课程 |
|---|---|
| 审批 | [s03](../s03_approval/) |
| 安全判定链 | [s28](../s28_sessions_sandbox_safety/) |

### [约束——决定验证出错时损失被限制在哪](./harness-engineering.md#constrain)

| 笔记小节 | 课程 |
|---|---|
| 沙箱 | [s04](../s04_sandbox/)、[s28](../s28_sessions_sandbox_safety/) |
| 三级隔离 | [s18](../s18_worktree_isolation/)、[s23](../s23_review_ci_cloud/) |
| 拒绝权与认领竞态 | [s12](../s12_task_system/)、[s17](../s17_autonomous_agents/) |

### [合起来——一次旅程、两张地图、一个引擎](./harness-engineering.md#together)

| 笔记小节 | 课程 |
|---|---|
| 旅程与三道接缝 | [s20](../s20_full_harness/) |
| 一个引擎，许多前端 | [s21](../s21_codex_cli/)、[s27](../s27_codex_service_surfaces/) |

一章可以同时服务两关，一关也会覆盖多章。上表是**主归属**；产品面加深（`s21`–`s28`）常常是同一机制的另一张脸。

<a id="reverse-index"></a>

## 反查：`s01`–`s28` → 环节

| 章 | 主题 | 主环节 | 也出现在 |
|---|---|---|---|
| [s01](../s01_agent_loop/) | Agent Loop | [执行](./harness-engineering.md#execute) | [合起来](./harness-engineering.md#together) |
| [s02](../s02_tool_use/) | Tool Use | [行动](./harness-engineering.md#act) | — |
| [s03](../s03_approval/) | Approval | [验证](./harness-engineering.md#verify) | — |
| [s04](../s04_sandbox/) | Sandbox | [约束](./harness-engineering.md#constrain) | — |
| [s05](../s05_plan_tool/) | Plan Tool | [感知](./harness-engineering.md#perceive) | — |
| [s06](../s06_subagents/) | Subagents | [感知](./harness-engineering.md#perceive) | — |
| [s07](../s07_skills/) | Skills | [感知](./harness-engineering.md#perceive) | — |
| [s08](../s08_context_compact/) | Context Compaction | [感知](./harness-engineering.md#perceive) | — |
| [s09](../s09_memory_sessions/) | Memory & Sessions | [感知](./harness-engineering.md#perceive) | [执行](./harness-engineering.md#execute) |
| [s10](../s10_instructions/) | Instructions | [感知](./harness-engineering.md#perceive) | — |
| [s11](../s11_error_recovery/) | Error Recovery | [执行](./harness-engineering.md#execute) | — |
| [s12](../s12_task_system/) | Task System | [约束](./harness-engineering.md#constrain) | [执行](./harness-engineering.md#execute) |
| [s13](../s13_background_tasks/) | Background Tasks | [执行](./harness-engineering.md#execute) | — |
| [s14](../s14_automations/) | Automations | [执行](./harness-engineering.md#execute) | — |
| [s15](../s15_agent_teams/) | Agent Teams | [执行](./harness-engineering.md#execute) | — |
| [s16](../s16_team_protocols/) | Team Protocols | [执行](./harness-engineering.md#execute) | — |
| [s17](../s17_autonomous_agents/) | Autonomous Agents | [约束](./harness-engineering.md#constrain) | [执行](./harness-engineering.md#execute) |
| [s18](../s18_worktree_isolation/) | Worktree Isolation | [约束](./harness-engineering.md#constrain) | — |
| [s19](../s19_mcp_servers/) | MCP Servers | [行动](./harness-engineering.md#act) | — |
| [s20](../s20_full_harness/) | The Full Harness | [合起来](./harness-engineering.md#together) | — |
| [s21](../s21_codex_cli/) | Codex CLI | [合起来](./harness-engineering.md#together) | — |
| [s22](../s22_config_toml/) | config.toml | [感知](./harness-engineering.md#perceive) | [行动](./harness-engineering.md#act) |
| [s23](../s23_review_ci_cloud/) | Review / CI / Cloud | [执行](./harness-engineering.md#execute) | [约束](./harness-engineering.md#constrain) |
| [s24](../s24_plugins_apps_hooks/) | Plugins / Apps / Hooks | [行动](./harness-engineering.md#act) | [验证](./harness-engineering.md#verify) |
| [s25](../s25_builtin_tools/) | Built-in Tools | [行动](./harness-engineering.md#act) | — |
| [s26](../s26_local_models_providers/) | Local Models | [行动](./harness-engineering.md#act) | — |
| [s27](../s27_codex_service_surfaces/) | Service Surfaces | [合起来](./harness-engineering.md#together) | [行动](./harness-engineering.md#act) |
| [s28](../s28_sessions_sandbox_safety/) | Sessions / Sandbox / Safety | [验证](./harness-engineering.md#verify) + [约束](./harness-engineering.md#constrain) | [感知](./harness-engineering.md#perceive) |

课程 README 里的色块（工具 / 规划 / 记忆 / …）是建造进度；这篇笔记只用感知、行动、执行、验证、约束。

## 图

`assets/` 与长文插图一一对应。若只想扫图：

- `five-elements.svg` — 五关
- `panorama.svg` — 循环全景
- `seams.svg` — 三道接缝
- `journey.svg` — 一次落地
