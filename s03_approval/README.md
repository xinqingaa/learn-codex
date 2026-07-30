# s03: Approval — 执行前先问一句

[中文](README.md) · [English](README.en.md)

s01 → s02 → `s03` → [s04](../s04_sandbox/) → ... → s20
> *"The model proposes, the policy disposes"* —— 模型提方案，审批策略做裁决。
>
> **Harness 层**：审批 —— 在工具执行前加一道门。

---

## 问题

s02 的 Agent 有了一组工具，而且每个调用都**立刻执行**。你说「帮我清理一下项目」，它可能真的跑 `rm -rf`。

安全不能靠「相信模型不会乱来」。模型会误判、会被注入的恶意内容带偏、会对含糊的指令做出激进解读。真正可靠的边界必须写在 harness 里：在工具执行**之前**，先判断这一下要不要经过人。

但每次都要人点头又太烦——读个文件也要确认，Agent 就没法用了。所以要的是**可调节的信任档位**。

---

## 解决方案

![Approval](images/approval.svg)

在 dispatch 之前插一道**审批门**。harness 先把每个工具调用分类成风险等级（`read` / `write` / `danger`），再由 `approval_policy` 决定：直接放行、拦下来问人、还是只在失败时才问。

Codex 的 `approval_policy` 有四种模式，对应四档信任：

| 模式 | 含义 | 何时停下来问人 |
|------|------|----------------|
| `never` | 全信，一概不问 | 从不——所有调用直接跑 |
| `on-failure` | 先跑，失败了再问 | 仅当某次调用**失败**时，问是否升级重试 |
| `on-request` | 只有危险的才拦 | 仅当调用被分类为 `danger`（如 `rm -rf`） |
| `untrusted` | 最多疑，默认拦 | 任何非纯读（`write`/`danger`/未知）都拦 |

被拦下的调用会在 REPL 里暂停，等你输入 `y`/`n`。**拒绝不是崩溃**：harness 把一条错误 item 喂回给模型，模型看到「被拒绝了」，可以换一条更安全的路线继续。

---

## 工作原理

在 s02 的分发循环上，只加「分类 + 审批门」这一层。

**第 1 步**：分类——harness 自己判断风险，而不是信任模型的自我申报。

```ts
type Risk = "read" | "write" | "danger";
function classify(call: OutputItem): Risk {
  if (call.name === "read_file" || call.name === "list_dir") return "read";
  if (call.name === "shell") {
    const cmd = JSON.parse(call.arguments).command.trim();
    if (DANGER.some((d) => cmd.includes(d))) return "danger"; // rm/sudo/dd/...
    if (READ_ONLY.some((r) => cmd.startsWith(r))) return "read"; // ls/cat/git status/...
    return "write";
  }
  return "write"; // write_file / apply_patch / 未知工具都算“会改东西”
}
```

**第 2 步**：策略决策——这次调用要不要在执行前拦下来。

```ts
function needsApprovalUpFront(policy: Policy, risk: Risk): boolean {
  switch (policy) {
    case "never":       return false;              // 一概不问
    case "on-request":  return risk === "danger";  // 只有危险的才拦
    case "untrusted":   return risk !== "read";    // 非纯读都拦
    case "on-failure":  return false;              // 先跑，失败后再问
  }
}
```

**第 3 步**：审批门。拦下来就问人；被拒绝就喂一条错误 item 回去，循环照常继续。

```ts
if (needsApprovalUpFront(POLICY, risk)) {
  const ok = await confirm(`hold [${POLICY}] ${call.name} risk=${risk}. Allow?`);
  if (!ok) {
    input.push({ type: "function_call_output", call_id: call.call_id,
                 output: `Error: denied by approval_policy (${POLICY})` });
    continue; // 模型看到拒绝，换条路走
  }
}
let result = dispatch(call.name, call.arguments);
```

**第 4 步**：`on-failure` 是另一种节奏——执行前什么都不拦，**失败后**才问要不要升级重试。

```ts
if (POLICY === "on-failure" && result.startsWith("Error")) {
  if (await confirm("call failed [on-failure] retry with approval?")) {
    result = dispatch(call.name, call.arguments); // 升级后再试一次
  }
}
```

四档策略共用同一个 `classify`，区别只在「什么时候问」。关键洞见：**审批是 harness 的职责，不是模型的礼貌**。模型可以提议任何事，能不能执行由策略说了算；而且「拒绝」对模型来说只是一条普通数据，它读到后继续推理，而不是让整轮崩掉。

---

## 试一下

> **教学 demo 提示**：离线 demo 会让模型尝试一次 `rm -rf agent_scratch`，审批门会拦下来等你回答。管道喂答案时把 `y`/`n` 放在任务之后即可（如 `printf 'do it\nn\nq\n'`）。代码只在当前目录创建/删除 `agent_scratch/`。

**无需 API key 也能跑**：默认策略是 `on-request`。离线模型会在**同一轮**里发起一次安全写入 + 一次危险的 `rm -rf`，让你看清「写入放行、危险命令被拦」。用环境变量切换四档策略各试一遍。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s03_approval/code.ts                              # 默认 on-request
APPROVAL_POLICY=untrusted npx tsx s03_approval/code.ts    # 连写入也拦
APPROVAL_POLICY=never     npx tsx s03_approval/code.ts    # 一概不问
OPENAI_API_KEY=sk-...     npx tsx s03_approval/code.ts    # 真实模型
```

试试这些 prompt：

1. `Create a scratch folder and put a note in it`（写入；on-request 下放行，untrusted 下被拦）
2. `Delete the scratch folder`（`rm -rf` 被判为 danger，on-request 下拦下来问你）
3. `List the files here`（纯读，任何策略都直接放行）

观察重点：同一组调用，在四种策略下哪些被拦、哪些放行？被拒绝的调用是如何变成错误 item 喂回给模型的？

---

## 接下来

审批解决的是「要不要跑」，但即使你点了 `y`，命令实际能碰到什么仍然没限制——一个被批准的 `rm -rf /` 照样能毁掉系统。而且 `on-request` 下模型每次写工作区外的文件都要问你，很烦。

s04 Sandbox → 用 `sandbox_mode` 在执行层画一条硬边界：只读 / 只能写工作区 / 完全放开。审批管「问不问」，沙箱管「碰得到什么」。

<details>
<summary>深入 Codex 源码</summary>

> 以下内容基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体架构。教学版的「classify + 四档策略 + 拦下问人」就是 Codex 审批机制的最小骨架；差异在于它和沙箱、TUI 的深度耦合。

**教学版的 `approval_policy` ≈ Codex 配置里的 `approval_policy`（在 `~/.codex/config.toml` 或 profile 里设置）。** 下面是真实实现的几个关键点。

<details>
<summary>一、四档模式是真实存在的枚举</summary>

Codex 把审批策略建模成一个四值枚举，语义与教学版一致：`untrusted`（最多疑，几乎什么都问）、`on-failure`（先跑，沙箱拒绝或失败时再请求升级）、`on-request`（由模型判断何时需要人批准）、`never`（从不问，常用于无人值守）。教学版为了聚焦「什么时候问」，把 `on-request` 简化成「只拦 danger」，把 `untrusted` 简化成「非纯读都拦」——方向一致，粒度更粗。

</details>

<details>
<summary>二、审批和沙箱是拧在一起的</summary>

教学版把审批（本章）和沙箱（s04）拆成两章，好讲清楚各自职责。但在 Codex 里二者是同一条执行路径上的两个阶段：一条命令先按 `sandbox_mode` 在受限环境里试跑；如果它需要更高权限（比如要写工作区外、要联网），并且当前 `approval_policy` 允许问人，harness 就会弹出审批，批准后用**提升的权限**重跑。也就是说，`on-failure` 的「失败」很多时候就是「沙箱拦住了」。教学版的「失败后问要不要重试」正是这个流程的简化。

</details>

<details>
<summary>三、问人的方式因前端而异</summary>

教学版在 REPL 里用 `y/n` 提问。Codex 的交互终端（TUI）会渲染一个审批面板，展示命令内容让你选择「允许 / 总是允许 / 拒绝」等；而非交互模式（`codex exec`，无人值守）通常配 `never`，因为没人可问——命令要么在沙箱里跑，要么直接失败。教学版用「拒绝就喂错误 item」统一了这条路径。

</details>

<details>
<summary>四、被拒绝的命令对模型是可见的</summary>

和教学版一样，Codex 不会在被拒绝时让整轮崩溃：拒绝结果会作为工具输出回到上下文，模型读到「用户没批准」后可以选择更安全的替代方案，或向用户解释它本想做什么。这让审批成为一次**对话**，而不是一堵墙。

</details>

**一句话**：Codex 的审批是 harness 的一等职责，用四档 `approval_policy` 调节「何时问人」，并与沙箱联动决定「批准后用多大权限重跑」。教学版把这条链路压成「分类 → 策略 → 拦下问人 → 拒绝喂回」，先把审批的职责边界吃透，s04 再把执行边界（沙箱）补上。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
