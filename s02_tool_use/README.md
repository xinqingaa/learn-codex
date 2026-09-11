# s02: Tool Use — 加一个工具，只加一行

[中文](README.md) · [English](README.en.md)

`s01` → `s02` → [s03](../s03_approval/) → s04 → ... → s20
> *"Add a tool, add a line"* —— 循环不动，新工具注册进 dispatch map 就能用。
>
> **Harness 层**：工具分发 —— 扩展模型能触达的边界。

---

## 问题

s01 的 Agent 只有一个 `shell` 工具。想读文件，模型得拼出 `cat path/to/file`；想写文件，得拼 `echo "..." > file`；想改一行，得拼 `sed -i 's/old/new/'`。

模型脑子里想的是「读这个文件」，却被迫先翻译成一条 shell 字符串。多了一层翻译：浪费 token、容易拼错、引号转义一地鸡毛，而且 harness 拿到的是一团字符串，没法做类型校验、没法知道它要碰哪个路径。

更糟的是，模型常常「一次性想做几件事」——读 a、读 b、再列一下目录。如果每件事都要先编成 shell，再逐条发，既慢又容易丢上下文。

---

## 解决方案

![Tool Use](images/tool-use.svg)

给模型一组**结构化工具**，再用一张 **dispatch map** 按名字路由。模型不再拼 shell，而是直接说「调用 `read_file`，参数 `{path: "a.ts"}`」；harness 收到 `function_call`，查表、调对应函数、把结果喂回去。

加一个工具只需两处改动：在 `TOOLS` 里加一条 schema（告诉模型「我能做什么」），在 `TOOL_HANDLERS` 里加一行映射（告诉 harness「怎么做」）。循环本身一行不动。

本章注册的 5 个工具：

| 工具 | 作用 | 为什么是结构化更好 |
|------|------|--------------------|
| `read_file` | 读文件（可只读前 N 行） | 参数是带类型的 `path`，不用拼 `cat`，结果干净 |
| `write_file` | 写文件（自动建父目录） | 不用操心引号转义和重定向 |
| `apply_patch` | 增 / 改 / 删文件（Codex 风格补丁） | 一次提交多处修改，语义明确、可审查 |
| `list_dir` | 列目录 | 不用解析 `ls` 的自由文本输出 |
| `shell` | 跑任意命令 | 保留为「兜底逃生舱」，但不再是唯一选择 |

模型还可以在**同一轮**返回多个 `function_call`——「读 a、读 b、列目录」一次说完，harness 逐个分发，这就是 fan-out。

---

## 工作原理

s01 的循环完整保留，唯一的变化在「执行工具」那一步：从硬编码 `runShell()` 变成查表分发。

**第 1 步**：定义工具 schema——模型看到的「菜单」。每个工具都是一个 Responses API function tool。

```ts
const TOOLS = [
  { type: "function", name: "read_file",  /* parameters: { path, limit? } */ },
  { type: "function", name: "write_file", /* parameters: { path, content } */ },
  { type: "function", name: "apply_patch",/* parameters: { patch } */ },
  { type: "function", name: "list_dir",   /* parameters: { path } */ },
  { type: "function", name: "shell",      /* parameters: { command } */ },
];
```

**第 2 步**：每个工具对应一个实现函数。参数是带类型的，不再是自由字符串。

```ts
function runReadFile(p: string, limit?: number): string {
  const lines = fs.readFileSync(resolvePath(p), "utf8").split("\n");
  return (limit ? lines.slice(0, limit) : lines).join("\n");
}
```

**第 3 步**：注册进 dispatch map——工具名到处理函数的映射。加一个工具 = 加一行。

```ts
const TOOL_HANDLERS: Record<string, (a: Args) => string> = {
  read_file:  (a) => runReadFile(String(a.path), a.limit),
  write_file: (a) => runWriteFile(String(a.path), String(a.content)),
  apply_patch:(a) => runApplyPatch(String(a.patch)),
  list_dir:   (a) => runListDir(String(a.path)),
  shell:      (a) => runShell(String(a.command)),
};
```

**第 4 步**：分发——按名字查表、解析参数、调用。未知工具返回错误，而不是崩溃。

```ts
function dispatch(name: string, argsJson: string): string {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return `Error: unknown tool '${name}'`;
  return handler(JSON.parse(argsJson));
}
```

**第 5 步**：循环里把硬编码的 `runShell(...)` 换成 `dispatch(...)`。模型一轮返回几个调用，就逐个分发几个——这就是 fan-out。

```ts
for (const call of calls) {                 // 一轮可能有好几个 function_call
  const result = dispatch(call.name, call.arguments);   // ← 唯一改动的那行
  input.push({ type: "function_call_output", call_id: call.call_id, output: result });
}
```

组装的完整循环和 s01 一字不差，只有执行那一行变了。这就是结构化工具的真正威力：**循环保持通用，能力靠注册扩张**。模型负责挑工具、填参数；harness 负责路由、执行、喂回。后面所有章节（审批、沙箱、计划）都是在这张分发表的前后再加一层，表本身不动。

---

### 深入一点：apply_patch 的补丁文法

登记表里最值得细看的是 `apply_patch`。Codex 不让模型用 `sed -i` / `echo >` 改代码，而是要求它产出一段**结构化补丁**——一种行导向的微型 DSL。完整文法（教学版 `parsePatch` 实现了它的子集）：

```text
*** Begin Patch
*** Update File: path/to/a.md        # 改一个已存在的文件
*** Move to: path/to/b.md            # （可选）顺手重命名 / 移动
@@                                   # hunk 头：锚定接下来这段改动
 上下文行（前缀一个空格，原样保留）
-要删除的行（前缀 -）
+要新增的行（前缀 +）
*** End of File                      # （可选）锚定到文件末尾
*** Add File: path/to/c.md           # 新建文件：下面的 + 行就是内容
+新文件第一行
*** Delete File: path/to/d.md        # 删除文件
*** End Patch
```

每条指令的含义：

| 指令 | 作用 | 备注 |
|------|------|------|
| `*** Begin Patch` / `*** End Patch` | 补丁信封，包裹所有操作 | 一个补丁可含多个文件操作 |
| `*** Add File: <path>` | 新建文件 | 后续 `+` 行即文件内容；文件已存在则报错 |
| `*** Update File: <path>` | 修改文件 | 后跟若干 hunk |
| `*** Move to: <path>` | 重命名 / 移动 | 只能跟在 `Update File` 之后 |
| `@@` | hunk 头 | 分隔不同的修改片段，锚定上下文 |
| `*** End of File` | 文件末尾锚点 | 表示该 hunk 作用于 EOF |
| ` ` / `-` / `+` 行前缀 | 上下文 / 删除 / 新增 | hunk 体的三种行 |

为什么 Codex 偏爱结构化补丁，而不是让模型自由发挥地改文件？三个字：

- **可审查（reviewability）**：补丁本身就是一份 diff，人一眼看清「改了哪个文件、删了哪行、加了哪行」。而 `sed -i 's/.../.../'` 的真实效果要跑完才知道。
- **原子性（atomicity）**：教学版先把**整个补丁解析完**（`parsePatch`），再在内存里算出每个文件的最终形态，**全部校验通过才落盘**。任何一个文件的上下文对不上，整个补丁被拒绝——磁盘上要么全是新内容，要么一个字节没动，绝不留写了一半的文件。
- **失败可恢复（failure recovery）**：每个 `Update File` 的 hunk 都要先在文件当前内容里**找到上下文**才替换。找不到？返回一条精确的错误（`Error: context not found in <path>`），模型下一轮拿着这条错误重试，而不是对着一个被改坏的文件发呆。

离线 demo 里你能同时看到这两种结局：第一轮补丁干净落地，第二轮补丁的上下文对不上、被整体拒绝，紧接着的 `read_file` 证明文件原封不动。

---

## 试一下

> **教学 demo 提示**：有 API key 时，代码会执行模型生成的工具调用（写文件、打补丁、跑 shell）。建议在临时目录里跑，避免误伤项目文件。离线模式只写入仓库根目录的 `.tmp/s02/`。s03/s04 会讲真正的审批 + 沙箱系统。

**无需 API key 也能跑**：没有 `OPENAI_API_KEY` 时走**离线剧本**——**不读你的提示词**，固定演示「一轮写出两个文件 → 一轮补丁（一份落地、一份因上下文对不上被整体拒绝）→ 核对」，和网页模拟器是同一条分镜。随便输入即可，盯 `function_call`（`continue`）和 `message`（`stop`），以及同一轮多个 `function_call` 如何按 `name` 查表。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s02_tool_use/code.ts                # 离线剧本（忽略提示词）
OPENAI_API_KEY=sk-... npx tsx s02_tool_use/code.ts   # 真实模型（工具跟着问题变）
```

设了 key 之后再试这些 prompt：

1. `Create two files a.md and b.md, then list the directory`（一轮 fan-out 多个调用）
2. `Read README.md and summarize this project in a new file SUMMARY.md`（read + write）
3. `Use a patch to add a "Usage" section to SUMMARY.md`（apply_patch）

观察重点：每一轮先打印完整的 `output`（返回值数组）。同一轮里几个 `function_call` 就是 fan-out，harness 按 `name` 路由。`apply_patch` 的参数是补丁正文，不要只看摘要。第二轮两个补丁，一个成功、一个被整体拒绝；随后的 `read_file` 证明文件原封不动。同一进程里再问一句，离线剧本**不会再跑工具**。

---

## 接下来

现在模型手里有 5 个工具，`write_file`、`apply_patch`、`shell` 想写就写、想删就删。让它「清理一下项目」，它可能真把东西删了。

s03 Approval → 在工具执行前加一道审批门：这次操作要不要先问过用户？`approval_policy` 的四种模式各有什么区别？

<details>
<summary>深入 Codex 源码</summary>

> 以下内容基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体架构。教学版的「schema 数组 + dispatch map」就是 Codex 工具系统的最小骨架；差异全在生产级的健壮性与安全性上。

**教学版的 `TOOL_HANDLERS` ≈ Codex 把模型的 function call 路由到具体工具实现的那一层。** 下面是真实实现里的几个关键点。

<details>
<summary>一、工具是一等公民，apply_patch 尤其特殊</summary>

Codex 给模型的工具集里，`apply_patch` 不是「锦上添花」，而是修改文件的**首选方式**。模型被明确要求用结构化的 patch（`*** Begin Patch ... *** Add/Update/Delete File ...`）来改代码，而不是 `echo >` 或 `sed`。教学版实现了一个极简的 Add/Update/Delete/Move 解析器；真实仓库里有一套完整的 patch 语法解析与校验（专用 grammar），能处理上下文匹配、移动文件等情况，并且 patch 会先经过审批与沙箱才落盘（见 s03/s04）。

**freeform 还是 JSON 函数？** 这是个值得说清的真实细节。`apply_patch` 可以有两种暴露给模型的方式：

| 方式 | 模型看到什么 | 约束强度 |
|------|--------------|----------|
| 普通 function tool（教学版用的） | 一个 JSON 参数 `{ "patch": "<字符串>" }` | 只保证是合法 JSON，补丁体本身可以是任意字符串，得靠 harness 解析时兜底 |
| freeform 自定义工具 | 一段**原始文本**，其语法被一条专用 **grammar 约束** | 模型在生成阶段就被文法限制，**根本产不出格式非法的补丁** |

这个区别曾由 `apply_patch_freeform` 这个 feature flag 控制。在当前 Codex（v0.144.x）里跑 `codex features list` 可以看到该 flag 状态为 `removed`——文法约束的 freeform 形式已经「毕业」成为标准行为，不再是可开关的实验项。教学版为了能用普通 Responses API function tool 演示，采用了第一种，但解析器（`parsePatch`）教的正是那套真实文法。

</details>

<details>
<summary>二、分发不是查 HashMap 这么简单，而是事件流里的路由</summary>

教学版在一轮结束后遍历 `calls` 数组逐个 `dispatch`。Codex 的核心循环消费的是一条**事件流**：模型边生成边发 `ResponseItem`，harness 一旦看到完整的 function call 就取出来，交给对应工具的处理逻辑执行，而不是等整轮结束。这让独立的工具调用可以更早起跑、并行执行（只读的工具之间没有依赖，可以同时跑），执行结果再作为 `function_call_output` 回到上下文。fan-out 在真实实现里是「真并发」，教学版是「顺序逐个」，概念一致。

</details>

<details>
<summary>三、每个工具调用都要过校验与策略管线</summary>

教学版的 `dispatch` 只做「解析参数 + 调用」。Codex 在真正执行一个工具前，会先做参数校验、再叠加两层策略：

| 层 | 作用 | 对应章节 |
|----|------|---------|
| 参数 / schema 校验 | 参数类型、必填项是否合法 | s02（教学版用 JSON Schema 兜底） |
| `approval_policy` | 这次调用要不要先问用户 | s03 |
| `sandbox_mode` + OS 隔离 | 这次调用实际能碰到哪些资源 | s04 |

教学版这一章只有最上面一层，下面两层在 s03/s04 逐个加回，分发表本身始终不变。

</details>

<details>
<summary>四、工具集可以扩展：内置工具之外还有 MCP</summary>

Codex 的内置工具（读、写、patch、shell 等）之外，还能通过 `mcp_servers` 接入外部工具——它们的 schema 会被一并列给模型，调用时桥接到对应的 MCP server。对模型而言，内置工具和 MCP 工具长得一模一样，分发层统一处理。s19 会专门讲 MCP 桥接。

</details>

**一句话**：Codex 的工具系统，核心仍是「模型按名字挑工具、harness 路由执行、结果喂回」。真实实现把这一层放进事件流、加上并发与策略管线。先把「注册 + 分发」吃透，后面的审批与沙箱都是在这张表的前后再加一层。

</details>

<!-- translation-sync: zh@v3, en@v3 -->
