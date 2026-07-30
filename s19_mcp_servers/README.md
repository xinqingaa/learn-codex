# s19: MCP Servers — 外接工具，标准协议

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s18](../s18_worktree_isolation/) → [s19](../s19_mcp_servers/) → [s20](../s20_full_harness/)
> *"External tools, one standard protocol"* — 发现、命名、调用，agent 不必知道工具是谁写的。
>
> **Harness 层**：协作 —— 用 MCP 把外部进程接成一等工具。

---

## 问题

从 s01 到 s18，agent 手里的每个工具都是我们亲手写进 harness 的——`shell`、`write_file`、任务板、worktree。每个工具的入参校验、执行逻辑、错误处理，都是你一行行写的。

现在你想接三个**别人的**服务：公司的 Jira（查 issue、建 ticket）、一套自建的部署系统（触发 deploy）、团队的知识库（搜文档）。你总不能为每个服务都在 harness 里重写一套工具代码，更不想每加一个服务就重新发布一次 agent。

你需要的是一个**标准协议**：外部服务只要实现它，agent 就能直接调用——不管那服务用什么语言写、跑在哪台机器上。这就是 MCP（Model Context Protocol）。

---

## 解决方案

![MCP Tool Bridge](images/mcp-servers.svg)

在 `~/.codex/config.toml` 的 `[mcp_servers.<name>]` 下声明一个服务器（`command` + `args`）。harness 把每个服务器 **spawn 成子进程**，通过 **stdio 按行读写 JSON-RPC 2.0**：先 `initialize` 握手，再 `tools/list` 发现它有哪些工具，然后把每个工具**桥接**成普通的 Responses API function tool，命名为 `mcp__<server>__<tool>`。模型像调任何其它工具一样调它，harness 在背后把这次调用翻译成一次 `tools/call` 发给子进程。

| 概念 | 含义 |
|------|------|
| `[mcp_servers.<name>]` | 在 config.toml 里声明一个服务器：`command` + `args`（+ 可选 `env`） |
| stdio JSON-RPC | harness 把服务器 spawn 成子进程，按行读写 JSON-RPC 2.0 消息 |
| `initialize` / `tools/list` | 握手 + 发现服务器提供哪些工具 |
| `tools/call` | 真正调用其中一个工具 |
| `mcp__<server>__<tool>` | 桥接后的工具名：命名空间防冲突，也是给模型看的名字 |

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

**第 2 步**：把服务器 spawn 成子进程，在它的 stdin/stdout 上按行收发 JSON-RPC。服务器端就三件事：响应 `initialize`、报出 `tools/list`、执行 `tools/call`（协议消息走 stdout，日志走 stderr，互不污染）。

```ts
async function connectMcp(name: string): Promise<McpClient> {
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
  this.tools = (await this.request("tools/list")).tools as McpToolDef[];   // 发现了哪些工具
}
```

**第 4 步**：桥接进工具注册表。把每个 MCP 工具包成一个 Responses API function tool，名字加上 `mcp__<server>__<tool>` 前缀防冲突；它的 handler 就是往子进程发一次 `tools/call`。

```ts
function bridgeTools(client: McpClient): void {
  for (const t of client.tools) {
    register(
      fn(`mcp__${norm(client.name)}__${norm(t.name)}`, `(MCP:${client.name}) ${t.description}`, t.inputSchema),
      (args) => client.callTool(t.name, args)   // 模型一调，就转成 tools/call 发给子进程
    );
  }
}
```

而驱动这一切的 `agentLoop`，**自 s01 起一行没变**：它只看到工具注册表里多了几个 function tool，照常调模型、派工具、喂结果。它不知道、也不需要知道这些工具背后是外部进程。

核心洞察：**MCP 是一层「进程 ↔ 工具」的翻译桥。** 对下，它跟子进程说 JSON-RPC（`initialize` / `tools/list` / `tools/call`）；对上，它把发现到的工具以普通 function tool 的形状呈给模型。模型看到的是一个叫 `mcp__docs__search` 的函数，按下调用，桥就替它跨进另一个进程、拿到结果、再喂回循环。于是「给 agent 加能力」从「改 harness 源码」变成了「在 config 里加一行声明」——服务用什么语言写、是不是第三方，都无所谓。

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
3. 从离线脚本里去掉对 `mcp__deploy__trigger` 的调用，改问一个不涉及部署的问题——体会 `(destructive)` 工具为何该走审批（回到 s03）。

观察重点：每个工具名是不是都带 `mcp__<server>__` 前缀？`initialize` → `tools/list` → `tools/call` 这三步在日志里是否清晰可辨？模型调 `mcp__docs__search` 时，背后是不是一次发往 `docs` 子进程的 JSON-RPC `tools/call`？

---

## 接下来

到这儿，agent 能通过一套标准协议接入任意外部工具了。但回头一看：前 19 章每章只加**一个**机制，散在 19 个 demo 里各跑各的——真实 harness 不是这样工作的。

工具注册、审批、沙箱、计划、记忆、子 agent、任务板、worktree、MCP……这些本该挂在**同一个循环**上协同工作。

s20 Full Harness → 把前面所有机制接回一个完整 harness，跑一条 narrated trace。机制很多，循环一个。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 MCP 公开协议，并对照 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`）的整体结构。教学版的「声明 → spawn → 桥接」是 MCP 客户端的最小骨架；真实实现把连接管理、命名与门控做成了生产级。

**教学版的 `McpClient` ≈ codex-rs 里每个 `[mcp_servers]` 条目的连接。** 差异在连接的生命周期管理与工具治理。

<details>
<summary>一、config.toml 里的声明：教学版与真实一致</summary>

教学版的 `MCP_CONFIG`（`command` + `args`）正是 Codex 在 `~/.codex/config.toml` 里 `[mcp_servers.<name>]` 表的形状。真实条目还能带 `env`（注入环境变量）、启动与调用的超时等；Codex 启动时会按配置逐个拉起并**监督**这些子进程。教学版省掉 `env` 与超时，专注「声明即连接」这一核心。

</details>

<details>
<summary>二、传输：stdio 是默认，HTTP 是扩展</summary>

教学版只用 **stdio**——把服务器 spawn 成子进程、按行收发 JSON-RPC，这是 MCP 的本地默认传输，也是 Codex 对本地服务器的做法。MCP 还支持基于 HTTP 的远程传输（连远端服务器），真实客户端会在连接管理器里同时维护多条本地 + 远程连接。教学版只保留 stdio，因为它是「外部进程接成工具」最直白的一种。

</details>

<details>
<summary>三、握手、发现与命名空间</summary>

教学版的 `initialize`（交换 `protocolVersion` 与双方 capabilities）→ `tools/list`（发现工具）→ `tools/call`（调用），是 MCP 的标准三步，Codex 连接服务器时走的就是这套。发现到工具后，真实实现会把**多台服务器**的工具聚合进同一个工具命名空间，并用前缀（教学版的 `mcp__<server>__<tool>`）避免不同服务器的同名工具互相撞车——这正是教学版演示的命名思路。

</details>

<details>
<summary>四、权限门控与「Codex 自己当服务器」</summary>

真实系统里，MCP 工具调用同样落在 Codex 的**审批与沙箱**策略之下——一个标注了破坏性的工具（教学版的 `deploy.trigger`）可以被 `approval_policy` 拦下来等人确认（见 s03）。另外，Codex 不仅能**消费** MCP 服务器，还能通过 `codex mcp` 把自己**作为**一台 MCP 服务器对外提供——让别的 agent 把 Codex 当工具调。教学版只演示了「消费」这一半，但桥的翻译机制两侧通用。

</details>

**一句话**：MCP 把「给 agent 加能力」从「改源码」变成「加一行 config」。教学版用一个子进程、三种 JSON-RPC 方法、一层 `mcp__` 前缀桥，就把「声明 → 发现 → 调用」跑通了；真实实现只是在此基础上叠加连接监督、多服务器聚合、HTTP 传输与权限门控。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
