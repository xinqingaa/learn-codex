# s01: Agent Loop — 一个循环就够了

[中文](README.md) · [English](README.en.md)

`s01` → [s02](../s02_tool_use/) → s03 → s04 → ... → s20
> *"One loop & a shell is all you need"* — 一个工具 + 一个循环 = 一个 Agent。
>
> **Harness 层**：循环 —— 模型与真实世界的第一道连接。

---

## 问题

你向大模型提了个需求：「帮我看看当前目录有哪些文件，然后把 `XXX.ts` 跑起来」。

模型能输出一条 shell 命令，但输出完就停了——它不会自己去跑，也看不到结果，更没法基于结果继续推理。

你可以手动跑一遍，把输出粘回对话框，让它接着干；下一条命令出来，你再跑、再粘。

每一个来回，你都在当中间层。把这个中间层自动化，就是本章要做的事。

---

## 解决方案

![Agent Loop](images/agent-loop.svg)

一个 `for (;;)` 循环：模型调用工具就继续，不调用就停。Codex 用的是 OpenAI **Responses API**——模型每轮返回一组 output items，整个过程只看一种信号：

| output item | 含义 | 循环动作 |
|-------------|------|---------|
| `type == "function_call"` | 模型举手说「我要用工具」 | 执行 → 把结果作为 `function_call_output` 喂回去 → 继续 |
| 没有 `function_call`（只有 `message`） | 模型说「我做完了」 | 打印最终文本，退出循环 |

`reasoning` item 是 Codex 这类推理模型的思考过程，harness 原样保留进上下文，不改变循环逻辑。

---

## 工作原理

把这个过程翻译成 TypeScript，分步来看：

**第 1 步**：把用户的问题作为第一条输入。

```ts
const thread = [{ role: "user", content: query }];
```

**第 2 步**：把输入和工具定义一起发给模型（Responses API）。

```ts
const resp = await openai.responses.create({
  model: MODEL, instructions: INSTRUCTIONS,
  input: thread, tools: TOOLS,
  reasoning: { effort: "medium" },   // Codex 跑在推理模型上
});
```

**第 3 步**：把这一轮输出（reasoning + message + 工具调用）整体追加进线程，然后检查有没有工具调用。没有 → 结束。

```ts
thread.push(...resp.output);
const calls = resp.output.filter((i) => i.type === "function_call");
if (calls.length === 0) return;
```

**第 4 步**：执行每个工具调用，收集结果。

```ts
for (const call of calls) {
  const { command } = JSON.parse(call.arguments);
  const result = runShell(command);
  thread.push({ type: "function_call_output", call_id: call.call_id, output: result });
}
```

**第 5 步**：结果已喂回线程，回到第 2 步。

组装成完整函数：

```ts
async function agentLoop(input) {
  for (;;) {
    const output = await callModel(input);
    input.push(...output);

    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) return;            // 模型不再调工具 → 完成

    for (const call of calls) {
      const result = runShell(JSON.parse(call.arguments).command);
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}
```

三十来行，这就是最小可运行的 agent harness 内核。它不是智能本身，而是让模型能持续行动的最小运行框架：**模型负责决策**（要不要调工具、调哪个），**harness 负责执行**（调了就跑、结果喂回去）。后面 19 章都在这个循环上叠加机制，循环本身始终不变。

---

## 试一下

> **教学 demo 提示**：代码会执行模型生成的 shell 命令。建议在一个临时测试目录里运行，避免误伤项目文件。s03/s04 会讲真正的审批 + 沙箱系统。

**无需 API key 也能跑**：没有 `OPENAI_API_KEY` 时，本章用一个内置的「离线脚本化模型」演示完整循环（它会假装调用两次 `shell` 然后收尾），方便你先把机制看明白。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s01_agent_loop/code.ts                # 离线 demo 模型
OPENAI_API_KEY=sk-... npx tsx s01_agent_loop/code.ts   # 真实模型
```

试试这些 prompt：

1. `Create a file called hello.ts that prints "Hello, Codex!"`
2. `List all TypeScript files in this directory`
3. `What is the current git branch?`

观察重点：模型什么时候调用工具（循环继续），什么时候不调用（循环结束）？

---

## 接下来

现在模型手里只有 `shell` 一个工具：读文件要 `cat`，写文件要 `echo ... >`，找文件要 `find`，又丑又容易出错。

s02 Tool Use → 给它一组真正的结构化工具（读、写、打补丁、搜索），会发生什么？模型会不会一次并行调用多个？几个工具同时跑会不会互相踩？

<details>
<summary>深入 Codex 源码</summary>

> 以下内容基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构。教学版的三十行 `for (;;)` 就是 Codex 核心 turn 循环的最小骨架；差异全是为了生产级健壮性叠加的保护机制。

**教学版的 `agentLoop` ≈ Codex 的 turn 循环。** 下面每一项都是在这个核心上做的加固。

<details>
<summary>一、循环判据：不是「没有 function_call 就停」这么简单</summary>

教学版靠「本轮还有没有 `function_call`」决定继续与否。Codex 的核心循环（`core` 里的 `run_turn` / `try_run_turn`）处理的是一条**事件流**：模型边生成边发 `ResponseItem`，harness 一旦看到完整的工具调用就派发执行，而不是等整轮结束。这让工具能更早并行起跑（见 s13 后台任务）。

</details>

<details>
<summary>二、Session 状态：教学版只有一个 input 数组</summary>

| # | Codex 里的概念 | 用途 | 对应章节 |
|---|----------------|------|---------|
| 1 | 会话历史 / turn 上下文 | 当前迭代的输入项 | s01 |
| 2 | `ExecPolicy` + 沙箱句柄 | 每条命令怎么批、在哪跑 | s03 / s04 |
| 3 | 压缩状态 | 上下文快满时自动 compact | s08 |
| 4 | 会话 rollout / 持久化 | 断点恢复、`codex resume` | s09 |
| 5 | 错误与重试计数 | 失败分类与恢复 | s11 |

教学版只保留第 1 项，其余都在后续章节逐个加回。

</details>

<details>
<summary>三、多条退出与恢复路径</summary>

教学版只有一条退出路径（模型不调工具就结束）。Codex 的 turn 还要处理：用户中断（Esc）、审批拒绝、沙箱违规、模型限流与重试、输出 token 上限、上下文超长触发的压缩重试等。每种都对应一种恢复或退出策略（s11 错误恢复会展开）。

</details>

<details>
<summary>四、审批与沙箱是真正的差异点</summary>

Codex 把「这条命令能不能跑、在哪跑」做成了 harness 的一等公民：`approval_policy`（untrusted / on-failure / on-request / never）决定何时停下来问人，`sandbox_mode`（read-only / workspace-write / danger-full-access）+ 操作系统级隔离（macOS Seatbelt、Linux Landlock）决定命令实际能碰到什么。教学版这一章只用一句字符串匹配兜底，s03/s04 会把这套真正建起来。

</details>

**一句话**：Codex 的生产级 turn 循环，核心仍是「调用模型 → 执行工具 → 喂回结果」这套动作。所有额外字段与退出路径都是保护机制。先吃透核心循环，后面的一切自然展开。

</details>

<!-- translation-sync: zh@v1, en@v0 -->
