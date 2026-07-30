# s24: Plugins, Apps & Hooks —— 能力，注册在 loop 周围

[中文](README.md) · [English](README.en.md)

`s01` → ... → `s20` → [s21](../s21_codex_cli/) → [s22](../s22_config_toml/) → [s23](../s23_review_ci_cloud/) → `s24` → `s25`
> *"Capabilities register around the loop"* —— 插件把技能、钩子、MCP 服务器打包成一次性安装；钩子在 loop 的生命周期事件上触发；loop 本身一行不改。
>
> **Harness 层**：Codex 深潜 —— 换的不是 loop，而是「谁往注册表里注册了能力、谁在事件点上插了一段命令」。

---

## 问题

s07 讲了**技能**（按需加载一段指令），s19 讲了 **MCP 服务器**（接一组外部工具）。它们都是「一次给 agent 加一样东西」。真实团队很快撞上三个新痛点：

1. **一样一样装太碎**——一个团队想让所有成员都拥有「同一份技能 + 同一条防护钩 + 同一个 MCP 服务器」，难道要每个人手动配三遍？能不能**打成一个包，一条命令装好**？
2. **想在 loop 的关键节点上插自己的逻辑**——每次工具调用**之前**先过一道「这道命令危不危险」的检查；每次调用**之后**记一条审计日志；会话**开始**时注入一段团队规约；一轮**结束**时发个通知。这些都不是新工具，而是**挂在 loop 生命周期上的自定义命令**。
3. **想让别的 agent 把 Codex 当工具用**——不是 Codex 去调 MCP 服务器，而是**把 Codex 自己变成一个 MCP 服务器**，让另一个 agent / MCP 客户端通过 stdio 调用它。

这三件事的共同点：s01 那个 loop 还是不动。问题只是**怎么把能力「注册」到 loop 周围**，以及**怎么在 loop 的事件点上挂命令**。

---

## 解决方案

![Plugins, Apps & Hooks](images/plugins-apps-hooks.svg)

一句话：**插件（plugin）把一堆能力打包成可安装的单元；钩子（hook）在 loop 的生命周期事件上触发自定义命令；`codex mcp-server` 把 Codex 自己暴露成 MCP 服务器。** 它们都只往「注册表」里写东西、或在事件点上触发，**从不改 loop**。

### 插件系统（`plugins` 特性，stable，默认开）

一个插件 = 一份 `plugin.json` 清单，把 **skills + hooks + mcpServers（以及 apps）** 打包，以「市场快照（marketplace snapshot）」的形式分发，一条命令安装。真实子命令（`codex plugin --help`）：

| 命令 | 作用 |
|------|------|
| `codex plugin add <PLUGIN[@MARKETPLACE]>` | 从已配置的市场快照安装插件；可配 `--marketplace <名>`、`--json` |
| `codex plugin list [--marketplace <名>] [--json] [--available]` | 列出市场快照里可用（含未安装）的插件 |
| `codex plugin marketplace add <SOURCE>` | 注册一个市场源：本地路径、`owner/repo[@ref]`、HTTPS/SSH Git URL；可配 `--ref`、`--sparse` |
| `codex plugin marketplace list [--json]` | 列出当前考虑的市场源及其根目录 |
| `codex plugin marketplace upgrade` | 刷新已配置的 Git 市场快照 |
| `codex plugin marketplace remove <名>` | 移除一个市场源 |
| `codex plugin remove <PLUGIN[@MARKETPLACE]>` | 从本地配置与缓存中卸载插件 |

相关的真实特性开关（`codex features list`）：`plugins`、`plugin_sharing`、`remote_plugin` 均为 **stable 且默认开启**。安装是「**在默认发现之上叠加**」——插件补进来的 skills/hooks/mcpServers 不会替换内置默认，而是合并。

### Apps（`apps` 特性，stable，默认开）

Apps（Connectors）是**打包好的「应用型」扩展**，来自 `chatgpt.com/apps`。在用户消息里可用 `[$app-name](app://{connector_id})` **显式**触发，也会在上下文合适时被**隐式**触发；一个已安装 app 的 MCP 工具要么直接提供、要么经 `tool_search` **惰性加载**。另有 `enable_mcp_apps` 仍标注为 *under development*（开发中）。它本质是「又一种打包形态」，本章不在 loop 里模拟。

### 钩子系统（`hooks` 特性，stable，默认开）

钩子是 harness 在**生命周期事件**上运行的自定义命令（来自 `hooks.json` 或某个插件），与「插件打包」是两回事——插件是「怎么分发」，钩子是「在事件点干什么」。真实事件名（来自本地二进制）：

| 钩子事件 | 触发时机 | 能干什么 |
|----------|----------|----------|
| `SessionStart` | 会话开始 | 注入额外上下文（团队规约、环境信息） |
| `UserPromptSubmit` | 用户提交一条 prompt | 审查 / 改写 / 记录输入 |
| `PreToolUse` | 工具调用**之前** | **可阻止（block）这次调用**——真实报错即 "Tool call blocked by PreToolUse hook" |
| `PostToolUse` | 工具调用**之后** | 审计、记日志、格式化结果 |
| `PermissionRequest` | 一次权限请求时 | 参与审批决策 |
| `SubagentStart` / `SubagentStop` | 子代理启动 / 停止 | 观测子代理生命周期 |
| `PreCompact` / `PostCompact` | 上下文压缩前后 | 围绕压缩挂钩 |
| `Stop` | 一轮 / 代理结束 | 通知、遥测、收尾 |
| `SessionEnd` | 会话结束 | 清理 |

### 把 Codex 变成 MCP 服务器（`codex mcp-server`）

`codex mcp-server` —— *Start Codex as an MCP server (stdio)*。方向反过来：不是 Codex 去连外部 MCP 服务器，而是**把 Codex 自己作为一个 MCP 服务器**跑在 stdio 上，让另一个 agent / MCP 客户端把「调用 Codex」当成调一个工具。

---

## 工作原理

把「插件注册 + 钩子触发」翻译成 TypeScript。核心是一个**注册表**：装插件 = 把清单里的 skills/hooks/mcpServers 合并进来；跑 loop = 在事件点上 `fire` 钩子。

**第 1 步**：钩子模型。真实钩子是外部命令（`hooks.json` 里配的脚本），harness 在事件点上运行它、喂一份 JSON 载荷、读一个决定。`PreToolUse` 可以 `block`；`SessionStart` 可以注入 `context`。

```ts
type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
interface HookDecision { block?: boolean; reason?: string; context?: string }
interface Hook {
  event: HookEvent; name: string;
  command: string;                       // 真实世界里这条钩子对应的 shell 命令
  run: (p: HookPayload) => HookDecision | void;
}
```

**第 2 步**：插件清单 = 一个能力的「包裹」，对应真实的 `plugin.json`。

```ts
interface PluginManifest {
  name: string; marketplace: string;     // 装成 name@marketplace
  skills: Skill[]; hooks: Hook[]; mcpServers: string[];
}
```

**第 3 步**：注册表。`installPlugin` 把包裹合并进默认发现之上；`fire` 按事件触发所有匹配钩子并收集决定。

```ts
class Registry {
  skills = new Map<string, Skill>(); hooks: Hook[] = []; mcpServers: string[] = [];
  installPlugin(m: PluginManifest): void {
    for (const s of m.skills) this.skills.set(s.name, s);
    this.hooks.push(...m.hooks); this.mcpServers.push(...m.mcpServers);
  }
  fire(event: HookEvent, payload: Omit<HookPayload, "event">): HookDecision[] {
    const out: HookDecision[] = [];
    for (const h of this.hooks.filter((x) => x.event === event)) {
      const d = h.run({ ...payload, event });
      if (d) out.push(d);
    }
    return out;
  }
}
```

**第 4 步**：s01 的 loop，只在周围插上钩子。注意 `PreToolUse` 是**在工具执行之前**触发——一旦任何钩子返回 `block:true`，这条命令根本不会运行。

```ts
async function agentLoop(reg: Registry, prompt: string): Promise<void> {
  const ctx = reg.fire("SessionStart", {}).map((d) => d.context).filter(Boolean).join("; ");
  reg.fire("UserPromptSubmit", { prompt });
  const thread: unknown[] = [{ role: "user", content: (ctx ? `[context] ${ctx}\n\n` : "") + prompt }];
  for (;;) {
    const output = await callModel(thread);
    thread.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) { reg.fire("Stop", {}); return; }       // 一轮结束
    for (const call of calls) {
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      const blocked = reg.fire("PreToolUse", { tool: "shell", input: command }).find((d) => d.block);
      const result = blocked ? `Tool call blocked by PreToolUse hook: ${blocked.reason}` : runShell(command);
      if (!blocked) reg.fire("PostToolUse", { tool: "shell", input: command, output: result });
      thread.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}
```

**核心洞察**：loop 从 s01 起没动过。装插件只是「往注册表写能力」；钩子只是「在事件点触发命令」。离线 demo 里你会看到：插件 `devtools@local` 一装，注册表多出 1 个技能、4 个钩子、1 个 MCP 服务器；随后 loop 跑起来，`SessionStart` 注入了「删除前要确认」的规约，于是当模型真的想跑 `rm -rf ./dist` 时，`PreToolUse` 防护钩**在它运行之前就拦下了**，而那条安全的 `ls -1` 则被 `PostToolUse` 记进了审计日志。**拦截发生在 loop 周围，不在 loop 里面。**

---

## 试一下

> **教学 demo 提示**：本章不碰文件系统——`shell` 工具只跑 `ls`，那条 `rm -rf` 会被钩子在运行前拦下。

**无需 API key 也能跑**：本章是**自运行演示**，没有 REPL。没有 `OPENAI_API_KEY` 时用脚本化模型驱动 loop：先尝试一条会被防护钩拦下的 `rm -rf`，再跑一条安全的 `ls`，最后收尾——让每种钩子都触发一次。旁白走 stderr。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s24_plugins_apps_hooks/code.ts                       # 离线 demo（插件注册 + 钩子触发轨迹）
OPENAI_API_KEY=sk-... npx tsx s24_plugins_apps_hooks/code.ts # 真实模型
```

试试这些实验：

1. 直接跑，分辨轨迹：`SessionStart` 注入的规约，怎么导致后面那条 `rm -rf` 被 `PreToolUse` **在运行前**拦下（注意 `PreToolUse` 出现了两次，但被拦的那次**没有**对应的 `PostToolUse`——工具根本没跑）。
2. 改 `DEVTOOLS` 清单（去掉 `guard-rm` 钩子）再跑，看 `rm -rf` 是不是就直接执行了——体会「防护来自注册的钩子，不来自 loop」。
3. 用真实 key 跑一遍，模型会自己决定先干什么；观察钩子依然在每次工具调用前后触发，与模型选择无关。

观察重点：`plugin` 那几行打印的注册表内容（技能 / 钩子 / MCP 服务器数量），以及 `Stop` 钩子在 agent 说完最后一句话**之后**才触发——它挂的是「一轮结束」这个事件，不是某次工具调用。

---

## 接下来

到这里，你已经看清了 Codex 的几乎全部「扩展表面」：技能（s07）、MCP（s19）、插件 / Apps / 钩子（本章），以及把 Codex 自己变成 MCP 服务器的 `codex mcp-server`。它们全都遵守同一条铁律——**注册在 loop 周围，绝不改写 loop**。

s25 将带你回到「一个 agent 怎么跟另一个 agent 分工」的更高层：从单个 harness 的扩展，走向多个 harness 的协作。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构，以及本地安装的 `codex` CLI（v0.144.6）的 `codex plugin --help` / `codex mcp-server --help` / `codex features list` 的真实输出和二进制字符串。教学版的「注册表 + 事件触发的钩子」就是这套扩展表面的最小骨架；真实实现的复杂度在打包格式、市场快照与钩子管线里。

**教学版的 `Registry` ≈ 真实 Codex 的能力注册；教学版的 `fire` ≈ 真实钩子引擎在事件点上的分发。** 下面每一项都是在这个核心上的展开。

<details>
<summary>一、插件 = plugin.json 清单 + 市场快照</summary>

真实插件由一份 `plugin.json` 清单描述，把 skills、hooks、mcpServers（以及 apps）打包。市场（marketplace）是一组插件的「快照」，源可以是本地路径、`owner/repo[@ref]` 或 Git URL（`codex plugin marketplace add`），`upgrade` 负责刷新 Git 快照，`add` 从快照安装。教学版用一个 `PluginManifest` 对象 + `installPlugin` 的「合并进注册表」对应这套；真实实现里这是「在默认组件发现之上叠加，而非替换默认」。

</details>

<details>
<summary>二、钩子事件与可阻止的 PreToolUse</summary>

真实钩子事件名（来自二进制）：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PermissionRequest`、`SubagentStart`/`SubagentStop`、`PreCompact`/`PostCompact`、`Stop`、`SessionEnd`。钩子是外部命令，harness 喂给它 JSON 载荷并读回一个 `hookSpecificOutput` 决定；`PreToolUse` 能**阻断**调用（真实报错 "Tool call blocked by PreToolUse hook"），`SessionStart` 能注入上下文。教学版把「外部命令」简化成 TS handler，但保留了「事件点触发 + block/context 决定」的语义。钩子与插件打包是两回事：`hooks` 特性（stable、默认开）管「事件点干什么」，`plugins` 特性管「怎么分发」。

</details>

<details>
<summary>三、Apps：打包好的应用/连接器</summary>

`apps` 特性 stable 且默认开。Apps（Connectors）来自 `chatgpt.com/apps`，可在用户消息里用 `[$app-name](app://{connector_id})` 显式触发，或由上下文隐式触发；其 MCP 工具可直接提供或经 `tool_search` 惰性加载。`enable_mcp_apps` 仍标注 *under development*（开发中）。教学版只在旁白里点出它的存在，因为它本质是「又一种打包形态」，不改变 loop。

</details>

<details>
<summary>四、codex mcp-server：方向反转</summary>

s19 讲的是 Codex 作为 MCP **客户端**去连外部服务器；`codex mcp-server` 则把 Codex 变成 MCP **服务器**（stdio），让另一个 agent / MCP 客户端把「调用 Codex」当成调一个工具。教学版用一行旁白点出这个反转，因为「把自己暴露成服务器」不改变 loop——只是给 loop 加了一个新的入口（同一扇门的又一种开法，呼应 s21）。

</details>

**一句话**：插件、Apps、钩子都不是新的 agent，而是「往同一个 loop 周围注册能力 / 在事件点挂命令」的三种方式；`codex mcp-server` 是把同一个 loop 反向暴露成工具。吃透「注册在 loop 周围，loop 不变」这一条，这套扩展表面就看懂了。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
