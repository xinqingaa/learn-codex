# s26: 本地模型与自定义 Provider —— 同一个 loop，换个模型后端

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s23](../s23_review_ci_cloud/) → [s24](../s24_plugins_apps_hooks/) → [s25](../s25_builtin_tools/) → `s26` → [s27](../s27_codex_service_surfaces/) → `s28`
> *"One loop, any backend"* —— 模型住在哪里，只是 harness 上的又一个可替换旋钮。
>
> **Harness 层**：Codex 深潜 —— 换的不是 loop，而是「模型后端指向谁、讲哪种线路协议」。

---

## 问题

从 s01 到 s25，有个隐含前提始终没被动过：**模型住在 OpenAI**。`callModel` 打向 `api.openai.com`，key 从 `OPENAI_API_KEY` 读，讲的是 OpenAI 原生 Responses API。

但现实里，很多人想把这个前提拆掉：

1. **想用本地开源模型**——机器上跑着 Ollama 或 LM Studio，里面有个 `gpt-oss:20b`。不想把代码发到云端，也不想付 API 钱，就想让 Codex 用**自己机器上**的模型干活。
2. **想走公司网关**——公司统一架了一条 LLM 网关（`https://llm.corp.example/v1`），所有流量、审计、计费都从它过。Codex 得指向它，而不是直连 OpenAI。
3. **想接第三方/自托管服务**——某个兼容端点，可能根本不讲 OpenAI 那套 Responses API，只讲老的 Chat Completions。

这三件事的共同点：s01 那个 loop 一点问题都没有——它只关心「把我的 input item 给后端，把 output item 拿回来」。问题是**怎么把「模型后端」也变成一个可替换的旋钮**：指向谁（base_url）、用什么凭证（env_key）、讲哪种线路协议（wire_api）。这不是 loop 的问题，是 loop 的「传输层」问题。

---

## 解决方案

![Local Models & Custom Providers](images/local-models-providers.svg)

关键洞察一句话：**把「模型后端」抽象成一张 provider 注册表 + 一个 wire_api 适配器**。loop 永远只讲 Responses 形状的 item；适配器是唯一知道「这个后端讲哪种 HTTP 方言」的地方。换 provider、换 wire_api，loop 一行不改。

**真实 CLI 的两条本地路径**（`codex --help` 核实）：

| flag | 作用 |
|------|------|
| `--oss` | 用开源 provider（本地模型），不连 OpenAI |
| `--local-provider <lmstudio\|ollama>` | 指定用哪个本地 provider；不配 `--oss` 时用 config 默认或交互选择 |
| `-m, --model <MODEL>` | 选模型，本地路径下如 `gpt-oss:20b` |

内置 OSS provider（当前 Codex 都讲 **Responses** 线路）：

| provider | 默认 base_url | 说明 |
|----------|---------------|------|
| `ollama` | `http://localhost:11434/v1` | 本地 Ollama 服务；新版起默认走 Responses 端点 |
| `lmstudio` | `http://localhost:1234/v1` | 本地 LM Studio；原生支持 Responses API |

**`model_providers` 配置表**（`config.toml`，自定义 provider 的四个旋钮）：

| 键 | 取值 | 作用 |
|----|------|------|
| `model_providers.<id>.name` | 显示名 | 提供方名称 |
| `model_providers.<id>.base_url` | URL | API 根地址（网关 / 自托管 / 本地） |
| `model_providers.<id>.env_key` | 环境变量名 | 从哪个环境变量读 key（本地 provider 可省） |
| `model_providers.<id>.wire_api` | `responses` | 线路协议；当前 Codex **只认 `responses`**（见下） |

自定义 id **不能**复用保留字 `openai` / `ollama` / `lmstudio`。

**`wire_api`：responses vs chat —— 以及 chat 已被移除。** 历史上 `wire_api` 有两个值：`responses`（OpenAI 原生，`/v1/responses`）和 `chat`（旧的 Chat Completions，`/v1/chat/completions`，很多网关与本地服务用它）。但在当前 codex-rs 里 **`chat` 已被移除**：配 `wire_api = "chat"` 会报「no longer supported」并指向 discussion #7782。换句话说 **Codex 现在原生只讲 Responses API**——本地 provider（ollama、lmstudio）都已加上 Responses 端点；一个**只讲 chat** 的后端，得在前面架一条**翻译代理**（如 LiteLLM）把 Responses 翻成 chat。

**profiles 把 provider+model 固化成预设**：`$CODEX_HOME/<name>.config.toml` 里写 `model_provider = "ollama"` + `model = "gpt-oss:20b"`，然后 `codex --profile <name>` 一键切到那套后端（profile 机制见 s22）。

---

## 工作原理

把「可替换的模型后端」翻译成 TypeScript，分步来看：

**第 1 步**：provider 注册表。每个条目就是 `model_providers.<id>` 的那四个旋钮，外加一个 `local` 标记（区分 `--oss` 的本地路径）。`openai` / `ollama` / `lmstudio` 是内置保留字。

```ts
interface ModelProviderInfo {
  id: string; name: string; baseUrl: string;
  envKey?: string; wireApi: WireApi; local?: boolean;
}
const REGISTRY: Record<string, ModelProviderInfo> = {
  openai:   { id:"openai", name:"OpenAI", baseUrl:"https://api.openai.com/v1", envKey:"OPENAI_API_KEY", wireApi:"responses" },
  ollama:   { id:"ollama", name:"Ollama (local)", baseUrl:"http://localhost:11434/v1", wireApi:"responses", local:true },
  lmstudio: { id:"lmstudio", name:"LM Studio (local)", baseUrl:"http://localhost:1234/v1", wireApi:"responses", local:true },
};
```

**第 2 步**：注册自定义 provider，并守住两条真实规则——保留字不能复用；当前 Codex 只认 responses。

```ts
function defineProvider(id, p) {
  if (["openai","ollama","lmstudio"].includes(id))
    throw new Error(`provider id "${id}" is reserved`);
  REGISTRY[id] = { id, ...p };
}
// 真实 Codex 加载 config 时：wire_api 非 responses → 报 "no longer supported"
```

**第 3 步**：wire_api 适配器——本章的核心。`encodeRequest` 把规范的 Responses 形状请求翻成后端的方言；`decodeResponse` 翻回来。chat 路径要双向翻译：`function_call` → assistant 的 `tool_calls`、`function_call_output` → `role:"tool"` 消息，响应里的 `tool_calls` 再翻回 `function_call` item。

```ts
function encodeRequest(p, req) {
  if (p.wireApi === "responses")
    return { url: `${p.baseUrl}/responses`, body: { model, instructions, input, tools } };
  // chat：把 Responses item 翻成 chat.completions 的 messages
  return { url: `${p.baseUrl}/chat/completions`, body: { model, messages: toChat(req), tools: toChatTools(req.tools) } };
}
function decodeResponse(p, raw) {
  if (p.wireApi === "responses") return raw.output;
  const msg = raw.choices[0].message;            // chat → 翻回 Responses item
  return [...(msg.tool_calls ?? []).map(toFunctionCall), ...(msg.content ? [toMessage(msg.content)] : [])];
}
```

**第 4 步**：agent loop——provider 无关，一字未改。它只调 `callProvider(p, …)`，拿回规范 item，根本不知道自己打向的是 OpenAI、公司网关、本地 ollama，还是一个 chat-only 后端。

```ts
async function agentLoop(p, task) {
  const input = [{ role: "user", content: task }];
  for (let step = 0; step < 8; step++) {
    const output = await callProvider(p, { model, instructions, input, tools }); // ← 唯一碰传输的地方
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) { /* 打印最终消息 */ return; }
    for (const call of calls) input.push({ type: "function_call_output", call_id: call.call_id, output: runShell(parse(call).command) });
  }
}
```

**核心洞察**：离线 demo 把**同一个任务**依次跑在 openai、corp 网关、本地 ollama、legacy-chat 四个 provider 上，并**打印每个线路请求**——你能看到 URL 和 body 形状随方言而变（`/responses` 配 `input`，`/chat/completions` 配 `messages`），而上面那层 loop、工具、任务**每一次都一模一样**。chat 那条路尤其说明问题：适配器把 Codex 的 Responses 调用翻译成 chat——这正是「翻译代理」（LiteLLM）干的事，也是旧版 Codex 在 chat 被移除前干的事。换的从来不是 loop，而是**后端指向谁、讲哪种方言**。

---

## 试一下

> **教学 demo 提示**：本章**不连任何真实后端**——本地/自定义/chat provider 全部用内置的「方言感知」脚本后端模拟；它真的 `echo` 一条命令证明 loop 真的在执行工具，但不碰你的文件系统、不发任何网络请求。设了 `OPENAI_API_KEY` 时，仅 openai 那一路走真实 Responses API。

**无需 API key 也能跑**：脚本化后端驱动 loop，把四种 provider 各跑一遍，打印每个线路请求。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实 OpenAI 就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s26_local_models_providers/code.ts                          # 离线 demo：四个 provider 各跑一遍
OPENAI_API_KEY=sk-... npx tsx s26_local_models_providers/code.ts    # openai 那一路走真实 API
```

试试这些实验：

1. 直接跑，对比四段输出：openai / corp 走 `/responses`，body 里是 `input`；legacy-chat 走 `/chat/completions`，body 里是 `messages`。URL 和形状都变了，loop 没变。
2. 看 ollama 那一段：模型自动切成 `gpt-oss:20b`、base_url 是 `localhost:11434`——一条「本地模型、不碰 OpenAI」的路。
3. 注意 legacy-chat 段开头那行 `[real codex] wire_api = "chat" is no longer supported…`——这正是当前 Codex 加载配置时会报的真实错误；demo 里的 chat 适配器演的是「翻译代理」的角色。

观察重点：四段里 loop 打的「`$ echo …`」和最终那条「Served by …」是不是结构完全一样？唯一变的是哪两行（`POST <url>` 和 body 形状）？

---

## 接下来

模型后端能换了——`--oss` 指向本地、`model_providers` 指向网关、wire_api 管方言。但到现在为止，我们打交道的都是「CLI 这个进程」：敲命令、看输出。真实的 Codex 还有另一张脸——**作为服务被别的程序调用**：`codex mcp-server` 把 Codex 本身变成一个 MCP 服务器、`codex app-server` / `exec-server` 暴露 socket 服务、桌面 app 与 IDE 插件都连到同一套内核上。

s27 Codex 服务化形态 → 看 harness 怎么从「一个 CLI」变成「一组可被远程驱动的服务」。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构、官方文档，以及本地 `codex`（v0.144.6）的 `--help` / `codex features list` 输出核实。教学版的「provider 注册表 + wire_api 适配器」就是这套机制的最小骨架。

**教学版的 `REGISTRY` + `encodeRequest`/`decodeResponse` ≈ 真实 Codex 的 `ModelProviderInfo` 与客户端构造。** 下面每一项都是在这个核心上的展开与核实。

<details>
<summary>一、--oss / --local-provider：内置的本地 provider</summary>

`codex --help` 里 `--oss`（"Use open-source provider"）与 `--local-provider <lmstudio|ollama>` 是真实 flag。codex-rs 内置了 `ollama`（默认 `http://localhost:11434/v1`）和 `lmstudio`（默认 `http://localhost:1234/v1`）两个 OSS provider，可用 `oss_provider = "ollama"` 在 config.toml 里设默认。早期曾有一个独立的 `ollama-chat` provider 走 Chat Completions，**已被移除**——现在两个本地 provider 都默认走 Responses 端点。教学版把它们直接写进 `REGISTRY` 并标 `local:true`，正是对应这套「内置本地后端」。

</details>

<details>
<summary>二、wire_api：responses-only 化，chat 已被移除</summary>

`wire_api` 由 codex-rs `model-provider-info` crate 里的 `WireApi` 枚举定义。**历史上**有 `Responses` 和 `Chat` 两个变体；当前版本**只剩 `Responses`**。配 `wire_api = "chat"` 会得到硬错误「`wire_api = "chat"` is no longer supported. How to fix: set `wire_api = "responses"`」（指向 discussion #7782，chat 于 2025-12 弃用、2026-02 移除）。教学版保留 chat 适配器并打印这行真实错误，是为了演示「翻译代理」这一角色——一个只讲 chat 的后端，现实里要靠 LiteLLM 之类的代理把 Responses 翻成 chat，Codex 自身已不再做这件事。

</details>

<details>
<summary>三、ModelProviderInfo 的全字段</summary>

真实 `ModelProviderInfo` 除教学版演示的 `name`/`base_url`/`env_key`/`wire_api` 外，还带 `request_max_retries`（默认 4）、`stream_max_retries`（默认 5）、`stream_idle_timeout_ms`、`http_headers`、`env_http_headers`、`query_params` 等网络细节。自定义 provider 的 id **不能**复用保留字 `openai` / `ollama` / `lmstudio`。这些都在 s22 的 config 深潜里核实过，本章复用同一结论。

</details>

<details>
<summary>四、profiles 与项目级配置的边界</summary>

`--profile <name>` 会把 `$CODEX_HOME/<name>.config.toml` 叠在基础配置之上，预设里可写 `model_provider` + `model`，一键切到某套后端（如「本地 ollama 预设」）。注意边界：**项目级** `.codex/config.toml` **不能**设置 provider 路由键（`model_provider`、`model_providers`、`oss_provider` 等）——这些只能在用户级 `~/.codex/config.toml` 里配。换句话说，「模型后端指向谁」是机器级决定，项目无权改。

</details>

**一句话**：本地模型、公司网关、第三方端点都不是新 agent，而是同一个 loop 换了个「传输层」。真实实现的复杂度几乎全在工程侧——内置 provider 的默认端口、wire_api 的 responses-only 化、provider 的重试/头/查询参数、profile 与项目级配置的边界——而不是在 loop 本身。吃透「注册表 + 一个会翻译方言的适配器，loop 不变」这一条，这套机制就看懂了。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
