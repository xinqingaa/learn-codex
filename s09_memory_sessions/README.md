# s09: Memory & Sessions — 把每一轮写进磁盘，会话就不会真正结束

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s08](../s08_context_compact/) → `s09` → [s10](../s10_instructions/) → `s11` → ... → s20
> *"Write every turn to disk, and a session never really ends"* — 每一轮都落盘，进程死了会话还在。
>
> **Harness 层**：记忆 —— 跨进程、跨会话的持久状态。

---

## 问题

从 s01 到 s08，`thread` 都只活在内存里。进程一关、终端一退，整个会话就没了。

这带来两个真实的麻烦。其一：你让 Agent 干一个要跑很久的活，中途想关掉、明天接着干——做不到，记忆随进程一起消失。其二：它干到一半，你想回顾「它之前到底做了什么、改了哪些文件」——没有任何记录可查。

模型本身没有持久状态，所有「记忆」都在上下文里；上下文在内存里；内存随进程消失。问题不在模型记性差，而在 **harness 从没把会话写到过一个比进程更长寿的地方**。

---

## 解决方案

![Rollout Persistence & Resume](images/memory-sessions.svg)

把会话写成一个**只追加（append-only）的 JSONL 日志**：每产生一个新 item（user 消息、工具调用、工具输出、最终回复），就立刻把它序列化成一行，追加到 `rollout.jsonl`。进程可以随时死掉，磁盘上的日志还在。

下次启动带上 `--resume`，把日志逐行读回来、按原顺序 replay 进一个空 `thread`，就能从上次停下的地方**精确**继续。这就是 `codex resume`。

| 概念 | 作用 | 教学版实现 |
|------|------|-----------|
| `rollout.jsonl` | 会话的只追加日志 | 每个 item 一行 JSON |
| `session_meta` | 日志头 | 首行记录 id / cwd / 启动时间 |
| write-through | 何时写盘 | item 一产生就追加，不等 turn 结束 |
| `--resume` / `codex resume` | 怎么续 | 读回每一行，replay 进新 thread |

关键设计是 **write-through**：不是等一轮结束才批量写，而是 item 一产生就落盘。这样无论进程在何时崩溃，磁盘上的记录都完整到最后一刻，最多丢一个还没跑完的 item。

---

## 工作原理

把这个过程翻译成 TypeScript，分步来看：

**第 1 步**：开新会话时写入日志头（`session_meta`），并截断旧文件。

```ts
function startRollout(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const meta = { type: "session_meta", id: `sess_${Date.now()}`, cwd: CWD, started: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(meta) + "\n"); // 截断：一个全新会话
}
```

**第 2 步**：write-through——item 一产生就追加成一行。

```ts
function appendRollout(path: string, items: unknown[]): void {
  if (items.length === 0) return;
  appendFileSync(path, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
}
```

**第 3 步**：每一轮把「新增的 item」持久化——先写 user 消息，跑完循环再把这一轮加进来的所有 item 补上。

```ts
thread.push(userItem);
appendRollout(ROLLOUT_PATH, [userItem]);          // 先持久化用户这一轮
const before = thread.length;
await agentLoop(thread);                          // 循环本身和 s01 一模一样
appendRollout(ROLLOUT_PATH, thread.slice(before)); // 再持久化这一轮新增的
```

**第 4 步**：resume——读回每一行，跳过 `session_meta`，replay 成 thread。

```ts
function loadRollout(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((r) => r.type !== "session_meta");
}
```

**第 5 步**：带 `--resume` 启动时，先重建再继续；否则开新会话。

```ts
if (RESUME && existsSync(ROLLOUT_PATH)) {
  thread = loadRollout(ROLLOUT_PATH);    // 从磁盘精确重建上次的线程
} else {
  startRollout(ROLLOUT_PATH); thread = []; // 否则开一个全新会话
}
```

**核心洞察**：持久化没有改变 agent 的形状——循环还是那个循环，工具还是那些工具。它只是把「thread 这个内存数组」镜像成「磁盘上一个只追加的日志」。因为每一项都在产生的瞬间落盘，进程在任何时刻死掉，磁盘上的记录都完整到最后一刻；resume 不过是对这个日志的一次重放。离线 demo 会先跑两轮写盘，然后在**同一次运行里**模拟「退出进程 → 带 `--resume` 重启」，从磁盘 replay 出 8 个 item，接着跑第三轮。

---

## 试一下

> **教学 demo 提示**：本章会**真的写文件**——把 rollout 日志写到磁盘（默认在系统临时目录，可用 `CODEX_ROLLOUT` 改到项目本地），也会执行模型生成的 `echo` 命令。

**无需 API key 也能跑**：没有 `OPENAI_API_KEY` 时，本章的离线 demo 自动跑完「写两轮 → 模拟 resume → 再跑一轮」的完整流程，无需任何输入。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s09_memory_sessions/code.ts                 # 新会话 + 模拟 resume
npx tsx s09_memory_sessions/code.ts --resume        # 真正从上次的日志续上
CODEX_ROLLOUT=./.codex/rollout.jsonl npx tsx s09_memory_sessions/code.ts  # 写到项目本地
```

试试这些实验：

1. 跑一遍，记下末尾打印的 rollout 路径，用 `cat` 打开看看：是不是每一行恰好是一个 item？
2. 紧接着再跑 `npx tsx s09_memory_sessions/code.ts --resume`，看 `[resume] loaded N item(s)`——它把上次写盘的全读回来了。
3. 设 `CODEX_ROLLOUT=./.codex/rollout.jsonl`，把日志写到当前目录，体会 Codex 真实的目录约定。

观察重点：第二轮之后的「模拟 resume」打印 `[resume] rebuilt thread: 8 item(s)`——这 8 个 item 不是从内存来的，是从磁盘日志 replay 出来的。

---

## 接下来

记忆能跨会话续上了。但 system prompt 还是 s01 那行硬编码的字符串：换个项目要重写，加个能力要手改，而且每轮请求都带上全量内容。它应该像配置一样，在运行时按层组装。

s10 Instructions → 内置 base + 项目 `AGENTS.md` + `config.toml` 偏好，运行时拼出 system prompt、模型和推理档位。

<details>
<summary>深入 Codex 源码</summary>

> 以下内容基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构。教学版的「每个 item 追加一行 → resume 时重放」就是 Codex 会话持久化（rollout）与 `codex resume` 的最小骨架；差异全在记录粒度与恢复入口的工程细节上。

**教学版的 `appendRollout` / `loadRollout` ≈ Codex 的 rollout 持久化与恢复。** 下面每一项都是在这个核心上做的加固。

<details>
<summary>一、真实路径：~/.codex/sessions 下的 rollout 文件</summary>

教学版把日志写到系统临时目录的一个固定文件。Codex 把每个会话的 rollout 持久化到用户目录下（`~/.codex/sessions/`，按日期分层），文件名大致是 `rollout-<时间戳>-<id>.jsonl`。这样一台机器上可以同时存在很多个历史会话，`codex resume` 才能列出它们让你挑。教学版用单一文件，是为了让「追加 → 重放」这条链路一眼可见。

</details>

<details>
<summary>二、rollout 记录的是结构化 item，不只是聊天文本</summary>

教学版把 thread 里的每个 item 原样序列化成一行 JSON。Codex 的 rollout 同样不是单纯的对话文本，而是**结构化的会话记录**：开头是会话元数据（id、工作目录、所用模型与配置等），之后按顺序记录每一项（用户输入、模型输出、工具调用与结果等）。正因为它存的是结构化项而非纯文本，resume 时才能把线程**精确**重建出来，而不是靠重新理解一段文字。

</details>

<details>
<summary>三、resume 的入口不止一种</summary>

教学版只有一个 `--resume` 开关，从固定文件续。Codex 的 `codex resume` 会列出本机保存的会话供你选择，也有「直接续最近一次」（如 `--last`）或指定某个会话的方式。入口不同，本质相同：定位到某份 rollout 文件，读回它的内容，重建线程，然后接着跑。

</details>

<details>
<summary>四、为什么是 append-only JSONL</summary>

教学版和 Codex 都选了「只追加 + 每行一条 JSON」这种格式，原因很实在：崩溃安全（已写入的行不会因中途退出而损坏）、写入便宜（追加一行是 O(1)，不用重写整个文件）、而且对人类友好（可以直接 `cat` / `tail` 出来审计每一步）。这也让 rollout 天然适合做「之后分析、复现、甚至交给别的工具处理」的会话存档。

</details>

**一句话**：Codex 的会话持久化核心就是教学版这套「每个 item 追加一行 → resume 时整段重放」。所有额外机制——按会话组织的存储目录、结构化元数据、多种恢复入口——都是为了让这条路径在多会话、长时间的真实使用里既稳又可查。先吃透「write-through + replay = 可恢复的会话」这一条，其余都是工程加固。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
