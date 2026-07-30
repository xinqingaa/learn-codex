# s13: 后台任务 — 慢操作丢后台，Agent 不等

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s12](../s12_task_system/) → `s13` → [s14](../s14_automations/) → `s15` → ... → s20
> *"Detach the slow command, keep reasoning, harvest it later"* — 慢命令后台跑，结果后续轮再收。
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

把慢命令**拆成两步**：先用 `run_background` 把它 `spawn` 到后台（立刻返回一个任务 id，**不阻塞**），Agent 继续用 `shell` 干别的活；等过几轮，再用 `check_background` 按 id 把结果**收回来**。循环还是 s01 那个循环，只多了两个工具：

| 工具 | 作用 | 返回 |
|------|------|------|
| `run_background` | 把慢命令 `spawn` 成子进程，登记进任务表 | 立刻返回 `bg_N`，附「还在跑，稍后查」 |
| `check_background` | 按 id 轮询任务表 | `still running` 或 `finished` + 捕获的输出 |
| `shell` | 跑快命令（同步，不变） | 立即返回输出 |

关键点：`run_background` 返回的不是结果，而是一个**句柄**。模型拿到 `bg_1` 就知道「这活还在跑」，于是先去做别的；后续某一轮再 `check_background(bg_1)`，要么「还没好」，要么「好了，这是输出」。**等待的时间被填满了**，而不是空转。离线 demo 里你能看到：第一次查是 `still running`，做完另一件活再查，就变成了 `finished` 并把输出收回来。

---

## 工作原理

在 s01 循环 + s02 分发表上，加一张后台任务表和两个工具，分步来看：

**第 1 步**：一张任务表，登记每个后台进程的 id、命令、状态、累积输出。

```ts
type BgTask = { id: string; command: string; status: "running" | "done"; output: string };
const bgTasks = new Map<string, BgTask>();
```

**第 2 步**：`startBackground` 用 `spawn` 起子进程——它是**异步**的，调用即返回。输出流持续累积，进程退出时把状态置为 `done`。

```ts
function startBackground(command: string): string {
  const id = `bg_${++bgSeq}`;
  const task: BgTask = { id, command, status: "running", output: "" };
  bgTasks.set(id, task);
  const child = spawn(command, { cwd: CWD, shell: true });   // 立刻返回，不阻塞
  child.stdout?.on("data", (d) => (task.output += String(d)));
  child.stderr?.on("data", (d) => (task.output += String(d)));
  child.on("close", (code) => { task.status = "done"; task.output += `\n(exit ${code})`; });
  return `Started ${id} in the background. Poll it with check_background.`;
}
```

**第 3 步**：`checkBackground` 按 id 查表。还在跑就回「running」，跑完了就把累积的输出交回去——这就是「收割」。

```ts
async function checkBackground(id: string): Promise<string> {
  await flushIo();                       // 让事件循环把子进程回调跑完再读状态
  const t = bgTasks.get(id);
  if (!t) return `Error: no such background task ${id}`;
  return t.status === "running"
    ? `${id} still running: ${t.command}`
    : `${id} finished: ${t.command}\n--- output ---\n${t.output}`;
}
```

**第 4 步**：把两个工具注册进分发表，循环不变。模型先用 `run_background` 起慢活，穿插 `shell` 快活，再 `check_background` 收割。

```ts
const DISPATCH = {
  shell: (a) => runShell(a.command),                 // 快：同步
  run_background: (a) => startBackground(a.command), // 慢：后台
  check_background: (a) => checkBackground(a.id),    // 查：收割
};
```

**核心洞察**：同步工具把「调用」和「等待结果」绑成一件事；后台工具把它**拆成两件**——「启动」立刻返回句柄，「收割」留到后面。中间这段时间，Agent 的主循环空不出来去等，而是被别的工作填满。有个实现细节很能说明问题：前台 `execSync` 会**堵住 Node 的事件循环**，所以 `checkBackground` 开头要 `await` 一小下，让子进程的「退出 / 数据」回调先跑完——否则系统层面进程明明结束了，Node 却还没来得及把状态更新成 `done`。

---

## 试一下

> **教学 demo 提示**：离线 demo 的后台命令是 `sleep 1.5 && echo ...`，前台是 `echo` / `sleep 2`，不改任何真实文件。

**无需 API key 也能跑**：没有 `OPENAI_API_KEY` 时，内置离线模型会把「后台起构建 → 穿插干快活 → 第一次查还没好 → 再干一件活 → 第二次查收割输出」完整演一遍。

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

观察重点：慢命令是不是走了 `run_background` 并立刻返回了 `bg_N`？第一次 `check_background` 是不是 `still running`？Agent 在等待间隙有没有继续做别的，最后一次检查有没有把输出收割回来？

---

## 接下来

后台任务解决了「慢操作不阻塞主循环」。但如果想**定时**做某件事呢？比如「每天早 9 点跑一遍测试」「每 5 分钟检查一次服务状态」——不是由你或模型当下发起，而是到点自动触发。

s14 Automations → 给 Agent 装一个**闹钟**：一个迷你调度器，按 cron 节奏把任务排进队列，到点就唤起 Agent 去跑。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构。教学版的「spawn + 轮询收割」是异步执行的最小骨架；Codex 的核心是**全异步**的，差异在执行模型与结果回传的方式上。

**教学版的 `run_background` / `check_background` ≈ Codex 异步执行模型的最小切面。** 下面逐项对照。

<details>
<summary>一、Codex 核心是全异步（tokio），不是「同步 + 偶尔后台」</summary>

教学版默认同步（`execSync` 阻塞），只对「慢命令」单独开后台。Codex 的 Rust 核心跑在 **tokio 异步运行时**上：每一次命令执行都是 `spawn` 出一个子进程、返回一个句柄，核心循环 `await` 它而不是阻塞它。也就是说在 Codex 里「后台」不是一种特殊模式，而是**默认**——所有执行都是异步任务，区别在于有些被立刻 `await`（前台、要结果才能继续），有些被挂起稍后再收（后台）。教学版用「同步为常态、后台为例外」反过来讲，是为了让「把等待拆开」这个动作更显眼。

</details>

<details>
<summary>二、流式事件让「收割」不必靠轮询</summary>

教学版的模型要主动 `check_background` 轮询才知道后台好了没。Codex 的核心循环消费的是一条**事件流**：子进程的输出、退出都会作为事件进入流里，harness 可以在后续某个 turn 把「后台任务完成」作为一个事件**推**给模型，而不是等模型想起来去问。教学版用「模型主动轮询」还原的是同一件事的数据流，只是把「推」换成了「拉」——更显式，也更好教。

</details>

<details>
<summary>三、codex exec：没有 TUI 的非交互运行</summary>

`codex exec`（非交互模式）用**同一个**核心循环，但不启动 TUI、没有人类在中间：它把一个 prompt 跑到底，把事件流打印到 stdout 就退出。这正是后台/异步执行真正派上用场的地方——没有交互式用户可等，所有工作都必须被异步推进、到点收割。教学版的离线 demo 其实就是一种极简的「exec 式」运行：给它一个目标，它自己把后台任务跑完、收割、收尾，全程无需人盯着。

</details>

<details>
<summary>四、审批与沙箱仍然管着每一次执行</summary>

不管前台还是后台，Codex 里每一条命令落地前都要过 `approval_policy` 和 `sandbox_mode`（s03/s04）：异步不改变「能不能跑、在哪跑」，只改变「什么时候等结果」。教学版为了聚焦异步机制，把审批/沙箱略成了一句字符串匹配；真实实现里，后台 spawn 出的子进程同样跑在沙箱里、受同一套策略约束。

</details>

**一句话**：Codex 的执行本就是异步的——命令一律 `spawn` 成任务，前台后台只差在「立刻 await 还是稍后收」。教学版把这个模型压成两个工具（`run_background` 启动、`check_background` 收割），加上 `codex exec` 这个无交互入口，就是「慢操作不阻塞主循环」的全部要义。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
