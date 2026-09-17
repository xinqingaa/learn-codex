# lessons — Harness 方法论笔记

这套笔记从 `s01`–`s28` 的实现细节里退一步,只留下可迁移的部分:一个问题一般有哪些解法、codex 选了哪个、代价在哪。目的是把"拆解 codex"这件事转成"掌握 harness 工程"这件能力,也作为面试稿使用——每篇独立成文,讲清一个机制,不复述代码,细节请回原章节的 `README.md` 和 `code.ts`。

## 目录

| 篇 | 标题 | 覆盖机制(原章节) |
|---|---|---|
| [01](./01-agent-loop-and-tool-contract.md) | Agent Loop 与工具契约 | s01 agent_loop, s02 tool_use |
| 02 | 权限与信任边界:审批与沙箱 | s03 approval, s04 sandbox, s28 sessions_sandbox_safety |
| 03 | 可控性:计划可见与错误恢复 | s05 plan_tool, s11 error_recovery |
| 04 | 上下文工程与隔离 | s08 context_compact, s09 memory_sessions, s06 subagents, s18 worktree_isolation |
| 05 | 知识与指令装配 | s07 skills, s10 instructions |
| 06 | 规模化协作:并发、自动化、多智能体 | s12 task_system, s13 background_tasks, s14 automations, s15 agent_teams, s16 team_protocols, s17 autonomous_agents |
| 07 | 从教学系统到产品 | s19 mcp_servers, s21 codex_cli, s22 config_toml, s23 review_ci_cloud, s24 plugins_apps_hooks, s25 builtin_tools, s26 local_models_providers, s27 codex_service_surfaces |

配图在 `assets/`,与正文同名对应。
