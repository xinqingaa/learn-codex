# s13: 后台任务 — 慢操作 yield 出去，Agent 不等

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s12](../s12_task_system/) → `s13` → [s14](../s14_automations/) → `s15` → ... → s20
> *"Yield the slow command, keep reasoning, harvest later"* — 先等一个 yield 窗口，没跑完就交 session_id，后续轮再收。
>
> **Harness 层**：并发与自动化 —— 异步执行，不阻塞主循环。

---

## 问题

用过洗衣机吗？衣服扔进去、按下启动，你就去做饭、回消息——30 分钟后它「滴滴」提醒你。你不会站在洗衣机前干等半小时。

Agent 的 `shell` 工具也一样。`npm install` 要几分钟，`npm run build` 要几十秒。这些命令一跑，循环就卡在 `execSync` 里干等，什么也做不了。

读文件是毫秒级，不等；`git status` 一秒内返回，不等。但 `npm install` 是分钟级。Agent 干等几分钟，而模型调用按 token 计费——空转就是烧钱。

---

## 解决方案

![Background Tasks](images/background-tasks.svg)

Codex 原版把慢命令交给 **`unified_exec`**：`exec_command` 先 `spawn` 子进程，再等一个 **yield 窗口**（默认约 10 秒）。窗口内结束，这一次工具调用就交输出；还在跑，才把 `session_id` 交回去。之后模型用 `write_stdin`（空 `chars` = 轮询）再等一个窗口，把新输出或最终结果收回来。循环还是 s01 那个循环，只多了这两个工具：

| 工具 | 作用 | 返回 |
|------|------|------|
| `exec_command` | `spawn` 子进程，最多等到 `yield_time_ms` | 窗口内结束：输出 + `exit_code`；还在跑：`session_id` + 目前输出 |
| `write_stdin` | 按 `session_id` 再等一个 yield 窗口（`chars` 为空 = 轮询） | 新输出，或 `exit_code` + 收割到的输出 |
| `shell` | 跑快命令（教学版仍同步；原版命令都走异步） | 立即返回输出 |

关键点：`exec_command` **不是立刻返回一个 id 就走**。它会先等 yield 窗口——快命令往往这一次就结束了；只有慢命令才会带着 `session_id` 回到模型。模型拿到「still running」才去干别的，后续某一轮再 `write_stdin`。**等待被别的工作填满**，而不是空转。

同时 harness 会给**客户端**打一条事件流（`ExecCommandBegin` / `ExecCommandEnd`）。那是给 TUI 看的，**不会自动灌进模型上下文**。离线 demo 里你能看到：第一次 `exec_command` 是 `still running` + `session_id: 1`，穿插干活后再 `write_stdin`，才把 `build artifacts ready` 收回来；控制台的 `[event]` 行模型看不见。

---

## 工作原理

在 s01 循环 + s02 分发表上，加上 Codex 同款的 yield / 收割，分步来看：

**第 1 步**：一张会话表，登记每个后台进程的 `session_id`、命令、状态、累积输出，以及已经给过模型看的偏移。

```ts
type ExecSession = {
  sessionId: number; command: string; status: "running" | "done";
  output: string; seen: number; exitCode: number | null;
};
const sessions = new Map<number, ExecSession>();
```

**第 2 步**：`exec_command` 用 `spawn` 起子进程，然后 **等到 yield 截止或进程退出**。调用会返回，但不是瞬间返回——窗口内的等待发生在这一次工具调用里。

```ts
async function execCommand(cmd: string, yieldTimeMs: number): Promise<string> {
  const session = spawnSession(cmd);
  const start = Date.now();
  await waitYield(session, yieldTimeMs);
  return formatExecResult(session, Date.now() - start);
}
```

**第 3 步**：窗口结束时，跑完了就交 `exit_code` 和输出；还在跑就把 `session_id` 交回去。`write_stdin` 按这个 id 再等一个窗口，把从上次切面之后的新输出收回来——这就是「收割」。教学版只实现空 `chars` 轮询；原版非空 `chars` 会写进进程的 PTY。

```ts
async function writeStdin(sessionId: number, chars: string, yieldTimeMs: number): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return `Error: no such session ${sessionId}`;
  if (chars) {
    return `Error: this teaching demo only supports empty write_stdin polls; ` +
      `real Codex writes non-empty chars to the process PTY.`;
  }
  const start = Date.now();
  await waitYield(session, yieldTimeMs);
  return formatExecResult(session, Date.now() - start);
}
```

**第 4 步**：把两个工具注册进分发表，循环不变。模型先 `exec_command`，穿插 `shell` 快活，再 `write_stdin` 收割。

```ts
const DISPATCH = {
  shell: (a) => runShell(a.command),
  exec_command: (a) => execCommand(a.cmd, a.yield_time_ms),
  write_stdin: (a) => writeStdin(a.session_id, a.chars, a.yield_time_ms),
};
```

**核心洞察**：同步工具把「调用」和「等到结束」绑成一件事；`unified_exec` 把它拆成「这一次工具调用最多等多久」。yield 窗口内结束，对模型来说就是一次普通工具结果；窗口到了还在跑，模型拿到的是句柄，不是完成通知。客户端事件流和模型上下文是两层：TUI 可以实时刷输出，模型只能在下一次 `exec_command` / `write_stdin` 的工具结果里看到切面。会话已经空闲时进程退出，原版也**不会**因此自动再开一轮推理。

---

## 试一下

> **教学 demo 提示**：离线 demo 的慢命令是 `sleep 1.5 && echo ...`，`yield_time_ms` 是 400，前台是 `echo` / `sleep 2`，不改任何真实文件。

**无需 API key 也能跑**：没有 `OPENAI_API_KEY` 时，内置离线模型会把「`exec_command` yield 后仍在跑 → 穿插干快活 → 第一次 `write_stdin` 还没好 → 再干一件活 → 第二次 `write_stdin` 收割输出」完整演一遍。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s13_background_tasks/code.ts                # 离线 demo 模型
OPENAI_API_KEY=sk-... npx tsx s13_background_tasks/code.ts   # 真实模型
```

试试这些 prompt：

1. `Run the build in the background and read package.json while it runs`
2. `Start the test suite in the background, then keep refactoring src`
3. `Install dependencies in the background and scaffold the app meanwhile`

观察重点：慢命令是不是走了 `exec_command`，并且先等了一个 yield 窗口才返回 `session_id`？第一次 `write_stdin` 是不是 `still running`？控制台的 `[event] ExecCommandBegin/End` 是不是只打给客户端？最后一次 `write_stdin` 有没有把输出收割回来？

---

## 接下来

后台任务解决了「慢操作不阻塞主循环」。但如果想**定时**做某件事呢？比如「每天早 9 点跑一遍测试」「每 5 分钟检查一次服务状态」——不是由你或模型当下发起，而是到点自动触发。

s14 Automations → 闹钟在 loop 外面：到期把 prompt 塞进去。`cron` 新开一轮进 inbox，`heartbeat` 回到同一条 thread。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构。教学版的工具名和语义对齐 `unified_exec`：`exec_command` + `write_stdin` + `yield_time_ms`。下面只写源码里实际有的行为，不把客户端事件流说成「推给模型」。

**教学版 ≈ Codex `unified_exec` 的模型侧切面。** 下面逐项对照。

<details>
<summary>一、模型侧就是 exec_command / write_stdin，不是立刻返回 id</summary>

Codex 给模型的后台入口是 `unified_exec`：`exec_command` 默认 `yield_time_ms ≈ 10000`（首次调用常见上限约 30 秒），`write_stdin` 默认 yield 更短，空 `chars` 是后台轮询。进程在窗口内退出，这一次工具结果就是输出 + `exit_code`，没有 session；窗口到了还在跑，才返回 `session_id`，进程留在 `UnifiedExecProcessManager` 里。教学版沿用这两个工具名和这套「先等窗口、再交句柄」的语义；为了 demo 能在几秒内跑完，离线脚本把 yield 缩到 400ms。

</details>

<details>
<summary>二、EventMsg 是给客户端的，不是不停推给模型</summary>

子进程的输出、退出会变成 `ExecCommandBegin`、`ExecCommandOutputDelta`、`ExecCommandEnd` 进入 harness 的 **客户端事件流**，TUI / `codex exec` 的 stdout 靠它刷进度。模型上下文里没有这条流。模型要再看进度，必须再调 `write_stdin`（或用户新开一轮）。教学版把 Begin/End 打成 `[event]` 行，就是为了把「给 UI 的流」和「给模型的工具结果」拆开；它**没有**在进程退出时自动往 `input[]` 里塞一条完成通知。

</details>

<details>
<summary>三、空闲时完成后不会自动叫醒模型</summary>

进程退出时，exit watcher 会发 `ExecCommandEnd`。若当时这一轮已经结束、会话空闲，原版 **不会**因此再开一轮推理——事件停在客户端。模型要看到结果，得靠后续的 `write_stdin`、用户再发一句，或客户端另外把完成消息交回去。把「完成后自动 wake」做成原版能力是不准确的；那是开着的增强，不是现成行为。教学版同样不自动 wake。

</details>

<details>
<summary>四、Codex 核心是全异步；教学版仍把快活留在同步 shell</summary>

Codex 的 Rust 核心跑在 **tokio** 上：命令一律 `spawn` 子进程，前台后台只差在「这一次工具调用立刻 await 到结束，还是 yield 后再收」。教学版为了让「拆开等待」看得见，把快命令留在 `execSync` 的 `shell` 里，只让慢命令走 `exec_command`。真实实现里没有这种快/慢分家，审批（`approval_policy`）和沙箱（`sandbox_mode`）对每一次落地执行同样生效。教学版还略去了 PTY、非空 stdin、并行工具调用这些工程细节。

</details>

**一句话**：Codex 的后台是 yield 窗口 + `session_id` + `write_stdin` 收割；实时输出走客户端事件流，不走模型上下文。教学版把同一套模型侧接口在 TypeScript 里跑起来，并刻意把「UI 事件 ≠ 模型输入」打在控制台上。

</details>

<!-- translation-sync: zh@v2, en@v2 -->
