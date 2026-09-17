# s19: MCP Servers — 外接工具，标准协议

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s18](../s18_worktree_isolation/) → [s19](../s19_mcp_servers/) → [s20](../s20_full_harness/)
> *"External tools, one standard protocol"* — 发现、命名、调用，agent 不必知道工具是谁写的。
>
> **Harness 层**：协作 —— Codex 作为 MCP **客户端**，在会话启动时把外部进程接成一等工具。

---

## 问题

从 s01 到 s18，模型能调的工具，几乎都是我们写进 harness 的——`shell`、`write_file`。s12 的任务板、s18 的 worktree **不是**又一个模型工具：worktree 是 session 的 cwd。能力边界还是那几个内置函数。

现在要接三个**别人的**服务：公司的 Jira、一套自建部署系统、团队的知识库。你总不能为每个服务都在 harness 里重写一套工具，更不想每加一个就重新发布一次 agent。

你需要的是一个**标准协议**：外部服务只要实现它，agent 就能直接调用——不管那服务用什么语言写、跑在哪台机器上。这就是 MCP（Model Context Protocol）。

Codex 的做法不是让模型先调一个「连接」工具，而是：**会话一开始就按 config 把服务器拉起来**。

---

## 解决方案

![MCP Tool Bridge](images/mcp-servers.svg)

在 `~/.codex/config.toml` 的 `[mcp_servers.<name>]` 下声明一个服务器（`command` + `args`）。harness 在**循环开始之前**把每个服务器 **spawn 成子进程**，通过 **stdio 按行读写 JSON-RPC 2.0**：先 `initialize` 握手，再 `tools/list` 发现它有哪些工具，然后把每个工具**桥接**成普通的 Responses API function tool，命名为 `mcp__<server>__<tool>`。模型像调任何其它工具一样调它；真正打给子进程的是原始 `tool.name`，一次 `tools/call`。

教学版多写了：本文件既是客户端，又用 `--mcp-server` 扮演两个 child。HTTP、`enabled_tools`、OAuth、把 Codex 自己当服务器，都不在本章。

| 概念 | 含义 |
|------|------|
| `[mcp_servers.<name>]` | 在 config.toml 里声明一个服务器：`command` + `args`（+ 可选 `env`） |
| 会话启动时 spawn | Codex 读 config 就拉起；模型**没有** `connect_mcp` 工具 |
| stdio JSON-RPC | 子进程按**行**收发 JSON-RPC 2.0（协议走 stdout，日志走 stderr） |
| `initialize` / `tools/list` | 握手 + 发现服务器提供哪些工具 |
| `tools/call` | 真正调用；`name` 是服务器的原始工具名 |
| `mcp__<server>__<tool>` | 给模型看的名字（Codex 仍保留 `mcp__` 前缀），防冲突 |

---

## 工作原理

四块：config 声明、spawn 子进程并说 JSON-RPC、握手 + 发现、以及桥接进工具注册表。

**第 1 步**：一个服务器长什么样？就是 config 里的一条「用哪个命令起」。这正是 `~/.codex/config.toml` 里 `[mcp_servers.*]` 表的形状。

```ts
const MCP_CONFIG: Record<string, { command: string; args: string[] }> = {
  docs:   { command: NODE, args: ["--import", "tsx", SELF, "--mcp-server", "docs"] },
  deploy: { command: NODE, args: ["--import", "tsx", SELF, "--mcp-server", "deploy"] },
};
```

**第 2 步**：把服务器 spawn 成子进程，在它的 stdin/stdout 上按行收发 JSON-RPC。服务器端就三件事：响应 `initialize`、报出 `tools/list`、执行 `tools/call`。

```ts
async function spawnMcp(name: string): Promise<McpClient> {
  const def = MCP_CONFIG[name];
  const child = spawn(def.command, def.args, { stdio: ["pipe", "pipe", "pipe"] });
  const client = new McpClient(name, child);
  await client.connect();                 // initialize 握手 + tools/list 发现
  return client;
}
```

**第 3 步**：握手与发现。`initialize` 交换协议版本与双方能力，随后 `tools/list` 拿回这个服务器暴露的全部工具定义。

```ts
async connect(): Promise<void> {
  await this.request("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "learn-codex", version: "0.1.0" }, capabilities: {} });
  this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  this.tools = (await this.request("tools/list")).tools as McpToolDef[];
}
```

**第 4 步**：桥接进工具注册表。给模型的名字带 `mcp__<server>__<tool>` 前缀；handler 往子进程发一次 `tools/call`，**用的是原始 `t.name`**。

```ts
function bridgeTools(client: McpClient): void {
  for (const t of client.tools) {
    register(
      fn(`mcp__${norm(client.name)}__${norm(t.name)}`, `(MCP:${client.name}) ${t.description}`, t.inputSchema),
      (args) => client.callTool(t.name, args)   // mcp__docs__search → tools/call { name: "search" }
    );
  }
}
```

`main()` 先 `spawnMcp("docs")` / `spawnMcp("deploy")`，再开 `agentLoop`。驱动这一切的循环**自 s01 起一行没变**：它只看到注册表里多了几个 function tool。它不知道、也不需要知道这些工具背后是外部进程。

核心洞察：**MCP 是一层「进程 ↔ 工具」的翻译桥。** 对下说 JSON-RPC；对上是普通 function tool。给 agent 加能力，从「改 harness 源码」变成「在 config 里加一行声明」。

---

## 试一下

> **教学 demo 提示**：代码会 spawn **两个子进程**（就是它自己，加 `--mcp-server` 参数）跑真实的 stdio JSON-RPC——纯本地、无网络、无需 key，不碰你的项目文件。

**无需 API key 也能跑**：本章是**自运行演示**，没有 REPL。没有 `OPENAI_API_KEY` 时用内置的离线脚本化模型——依次调用三个桥接工具：查知识库（`docs.search`、`docs.get_page`，标注 readOnly）和触发一次部署（`deploy.trigger`，标注 destructive），全程把 JSON-RPC 收发打印出来。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s19_mcp_servers/code.ts                # 离线 demo 模型
OPENAI_API_KEY=sk-... npx tsx s19_mcp_servers/code.ts   # 真实模型
```

试试这些改动：

1. 在 `SERVERS.docs.tools` 和 `handlers` 里再加一个工具（比如 `list_pages`），重跑看 `tools/list` 是否发现了它。
2. 用真实 key 跑，看模型如何自己挑选 `mcp__*` 工具来回答同一个问题。
3. 从离线脚本里去掉对 `mcp__deploy__trigger` 的调用，改问一个不涉及部署的问题——体会 `(destructive)` 工具为何该走审批（回到 s03）。本章**不实现**审批闸。

观察重点：每个工具名是不是都带 `mcp__<server>__` 前缀？`initialize` → `tools/list` → `tools/call` 这三步在日志里是否清晰可辨？模型调 `mcp__docs__search` 时，背后是不是一次发往 `docs` 子进程、`name: "search"` 的 JSON-RPC？连接发生在循环**之前**，还是模型自己调了某个连接工具？

---

## 接下来

到这儿，agent 能通过一套标准协议接入任意外部工具了。但回头一看：前 19 章每章只加**一个**机制，散在 19 个 demo 里各跑各的——真实 harness 不是这样工作的。

工具、审批、沙箱、计划、记忆、子 agent、MCP……这些本该挂在**同一个循环**的几条固定接缝上协同工作。任务板和 worktree 也是接缝上的机制，终点章不必再跑一遍。

s20 Full Harness → 把三类接缝上的代表套回同一个 `for (;;)`，跑一条 narrated trace。机制很多，循环一个。

<details>
<summary>深入 Codex 源码</summary>

> 以下对照官方文档 [Model Context Protocol](https://developers.openai.com/codex/mcp)，以及开源 [`openai/codex`](https://github.com/openai/codex)（`codex-rs`）。对照方式与 s12 相同：产品有 MCP 客户端；**没有** `connect_mcp` 模型工具；`codex mcp` **不是**「把自己当服务器」。

**教学版的 `McpClient` ≈ Codex 为每个 `[mcp_servers]` 条目维护的那条连接。** 本章多写的是：同一文件扮演两个 stdio child。

<details>
<summary>一、Codex 有 MCP 客户端，没有 connect_mcp 工具</summary>

说清楚「有 / 没有」：

- **Codex 有**：`[mcp_servers.<name>]` 的 stdio 声明（`command` / `args` / `env` / `cwd`）、会话**启动时** spawn 并监督子进程、`initialize` → `tools/list` → `tools/call`、CLI `codex mcp add|list|get|remove|login|logout`（管的是 **config 里的客户端条目**）、模型可见名上的 `mcp__` 前缀（源码里仍是 `LEGACY_MCP_TOOL_NAME_PREFIX`）。
- **Codex 没有**：模型工具 `connect_mcp`；也没有「先开循环、等模型决定再连」。连接发生在 harness 启动时。
- **本章额外实现**：本文件加 `--mcp-server docs|deploy` 再 spawn 自己，两条真 stdio 连接；离线模型连调 `search` → `get_page` → `trigger`。

`codex mcp` 是客户端配置管理器。把 Codex **作为** MCP 服务器对外提供（`codex mcp-server`，暴露 `codex` / `codex-reply`）是 s24 / s27。

</details>

<details>
<summary>二、stdio 是默认；HTTP 与过滤在 s22</summary>

教学版只用 **stdio**——spawn 子进程、按行收发 JSON-RPC。这是 MCP 的本地默认传输（规范就是换行分隔，不是 LSP 那种 Content-Length），也是 Codex 对本地服务器的做法。

真实条目还能带启动/调用超时、`enabled` / `required`、`enabled_tools` / `disabled_tools`，以及 HTTP 的 `url` + `bearer_token_env_var`。这些键 s22 已经列过，本章不实现。OAuth（`codex mcp login`）也不做。

</details>

<details>
<summary>三、命名空间：给模型看前缀，给子进程看原名</summary>

教学版的 `mcp__<server>__<tool>` 是 Codex 历史上的命名思路，用来避免两台服务器的同名工具撞车。真实实现还会清洗非法字符、卡 64 字节上限；真正打给子进程的始终是 **原始 `tool.name`**。

教学版的 `(readOnly)` / `(destructive)` 写在 description 里，不是 MCP 的 `readOnlyHint` 注解。只是给读者一个钩子：破坏性调用在真实 Codex 里仍走 `approval_policy`（s03），还可以按服务器设 `default_tools_approval_mode`。本章不叠审批。

</details>

<details>
<summary>四、本章不做的邻章</summary>

插件把 MCP 打进一个安装包是 s24。`codex mcp-server` / app-server 把引擎暴露出去是 s24 / s27。沙箱（s04）仍然锁的是当前 cwd——MCP 子进程是另一条进程，不要把 spawn 说成 sandbox。

resources / prompts 等 MCP 表面本章不演示。

</details>

**一句话**：Codex 按 config 在会话启动时拉起 MCP 服务器，再把发现到的工具当成普通 function tool；本章多写的是「同一文件扮演两个 child」，好让 stdio 三步看得见。

</details>

<!-- translation-sync: zh@v2, en@v2 -->
