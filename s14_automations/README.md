# s14: Automations — 到点自己跑

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s13](../s13_background_tasks/) → [s14](../s14_automations/) → [s15](../s15_agent_teams/) → ... → s20
> *"Set the schedule, the harness runs itself"* — 调度在 loop 外面，到点把 prompt 塞进去。
>
> **Harness 层**：并发与自动化 —— 独立调度器判断时间，队列传递触发。

---

## 问题

闹钟不需要你盯着它才会响。你设好 7:00，到点它自己响——你在睡觉、在洗澡、在做饭，它照响不误。

到目前为止，每一章的 Agent 都是**被动**的：你敲一句，它跑一轮。s13 让慢命令先 yield 再收割，但那一轮仍然是你手动敲出来的。

可「每天早上 9 点跑一遍测试」「每 30 分钟看一眼仓库有没有新动静」这类周期性工作，不该每次都要人来推一把。让 harness 自己决定**什么时候**该跑一轮，就是本章要加的机制。

---

## 解决方案

![Automations](images/automations.svg)

Codex 原版把这件事放在 **Agent loop 外面**。开源 CLI **没有**内置闹钟——它只提供无头入口 `codex exec`。真正的定时任务在 **Codex App**：一份 `automation.toml` + 本地调度器，到点把 prompt 交回同一个 loop。两种 kind，教学版都跑一遍：

| kind | 原版在做什么 | 教学版怎么演示 |
|------|----------------|----------------|
| `cron` | 每次新开一轮（像一次 `codex exec`），发现写进 **inbox / Triage** | 新鲜的 `[Scheduled]` 用户消息 + inbox |
| `heartbeat` | 把 prompt 塞回**同一条 thread**，带着旧上下文继续 | 往 `heartbeatThread` 追加 `[Heartbeat]` 再跑一轮 |

调度器每个 tick 只做一件事：把到期的 automation **入队**。派发器在 Agent 空闲时取出，按 kind 决定是新开一轮还是续上旧 thread。触发与执行靠队列解耦。

> 教学版用**模拟时钟**（每 tick 一分钟）和五段 cron 代替原版的 RRULE，让 demo 几秒跑完。换成真实时钟 + RRULE，就是 App 里那套调度。

---

## 工作原理

分四块：到期判断、调度器（生产者）、两种派发、那个不变的 agent loop。

**第 1 步**：到期判断。原版存的是 RFC 5545 `rrule`（`FREQ=DAILY;BYHOUR=9;BYMINUTE=0`）。教学版用五段 cron 当最小替身，语义仍然是「这一分钟该不该响」。

```ts
function cronFieldMatches(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    if (part === "*") return true;
    const step = /^(\*)\/(\d+)$/.exec(part);
    if (step && value % Number(step[2]) === 0) return true;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range && value >= Number(range[1]) && value <= Number(range[2])) return true;
    if (/^\d+$/.test(part) && value === Number(part)) return true;
  }
  return false;
}
```

**第 2 步**：automation 带 `kind`。`cron` 每次从零开始；`heartbeat` 挂在一条活着的 thread 上。`lastRunAt` 对应 App 调度库里的 `last_run_at`：同一分钟不响两次。

```ts
type Kind = "cron" | "heartbeat";
type Automation = {
  id: string; kind: Kind; cron: string; prompt: string;
  recurring: boolean; lastRunAt?: string;
};
```

**第 3 步**：调度器是生产者。每个 tick 把命中的任务**入队**——它从不亲自执行。一次性任务触发后注销（原版 RRULE 里的 `COUNT=1`）。

```ts
tick(now: SimTime): void {
  const marker = `${now.hour}:${now.minute}@${now.dom}`;
  for (const a of [...this.automations.values()]) {
    if (!cronMatches(a.cron, now) || a.lastRunAt === marker) continue;
    a.lastRunAt = marker;
    firedQueue.push({ ...a });            // 只入队，不执行
    if (!a.recurring) this.automations.delete(a.id);
  }
}
```

**第 4 步**：派发器按 kind 分叉。`cron` 开一个新的 input 数组，结果进 inbox；`heartbeat` 把 prompt 追加到同一条 thread 上再跑。两边调用的都是 s01 那个 loop。

```ts
if (job.kind === "heartbeat") {
  heartbeatThread.push({ role: "user", content: `[Heartbeat] ${job.prompt}` });
  await runTurn(heartbeatThread, job);
} else {
  const fresh = [{ role: "user", content: `[Scheduled] ${job.prompt}` }];
  const text = await runTurn(fresh, job);
  inbox.push({ id: job.id, at: job.lastRunAt ?? "", text });
}
```

**核心洞察**：Agent loop 不会自己看表。闹钟（App 调度器、系统 cron、CI、Cloud）在外面响，响完只做一件事——把一条用户消息交进 loop。`cron` 交的是一张白纸；`heartbeat` 交的是「回到刚才那句话」。队列保证调度器不用等 Agent 跑完。

---

## 试一下

> **教学 demo 提示**：offline demo 会执行只读 shell 命令（`git status` 等）。建议在临时目录里运行；真实的审批 + 沙箱见 s03/s04。

**无需 API key 也能跑**：本章是**自运行演示**，没有 REPL。没有 `OPENAI_API_KEY` 时用内置离线模型，把「到期 → 入队 → `cron` 进 inbox / `heartbeat` 续 thread」完整走一遍。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s14_automations/code.ts                # 离线 demo 模型
OPENAI_API_KEY=sk-... npx tsx s14_automations/code.ts   # 真实模型
```

试试这些改动：

1. 把某个 `cron` 的表达式改成 `"* * * * *"`，看它每个 tick 都新开一轮、inbox 变长。
2. 把 `watch` 的 heartbeat 改密一点，看同一条 `heartbeatThread` 在变长，而不是每次从零开始。
3. 用真实 key 跑一遍，观察模型如何为「check the repo status」挑命令。

观察重点：调度器只入队、从不执行；`cron` 的结果进 inbox；`heartbeat` 始终追加到同一条 thread。

---

## 接下来

现在 harness 能按时间表自己把 prompt 塞进 loop 了。但很多任务一个人扛不动：「重构整个后端」涉及认证、数据库、路由、测试，单个上下文装不下所有细节。

s15 Agent Teams → root 用 `spawn_agent` 拉起命名子 Agent，各自带上下文，靠 `send_message` / `wait_agent` 的进程内信箱交接，而不是把所有细节塞进一个窗口。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）、Codex App 的 Automations，以及官方文档 [Automations](https://developers.openai.com/codex/app/automations)。教学版对齐的是 **App 调度器** 的模型侧切面，不是「CLI 里藏了一个 cron」。

**教学版 ≈ Codex App 的一次到期触发。** 下面按真实入口对照。

<details>
<summary>一、开源 CLI 没有调度器，只有 `codex exec`</summary>

`codex-rs` 不在 agent loop 里跑 cron。无头入口是 **`codex exec`**：给一个 prompt，跑完一轮，把事件流打到 stdout，然后退出。本地想定时跑，是把系统 `cron` / `systemd timer` / GitHub Actions 接到这条命令上。CLI **没有** Scheduled 管理界面——官方文档写明：创建和查看定时任务走 ChatGPT / Codex App。

</details>

<details>
<summary>二、App Automations：automation.toml + 本地调度库</summary>

桌面 App 才内置闹钟。定义落在 `~/.codex/automations/<id>/automation.toml`，调度状态在本地 SQLite（`next_run_at`、`last_run_at`、`automation_runs`）。日程用 **RFC 5545 RRULE**，不是五段 cron；UI 可以让你填 cron，存下来仍是 `rrule`。本机任务要求电脑开着、App 开着、项目还在磁盘上。教学版的五段 cron + `lastRunAt` 就是这条「到期 / 幂等」路径的最小替身；进程内存代替 toml + sqlite，退出即丢。

</details>

<details>
<summary>三、两种 kind：cron 新开一轮，heartbeat 回到同一条 thread</summary>

原版 `kind = "cron"`（standalone）：每次触发新开 thread / 一次 `codex exec` 式运行，发现进 **inbox / Triage**，没东西可报就归档。可以跑在当前项目目录，也可以单独 worktree（s18）。`kind = "heartbeat"`：把 prompt 塞回 `target_thread_id` 那条对话，带着旧上下文继续——适合「盯着这个 PR / 等这个构建」。教学版的 `inbox` 和 `heartbeatThread` 分别对应这两条路。模型在 App 里用 `automation_update` 创建/改这些任务；教学版为了聚焦「到点怎么跑」，在 `main()` 里直接 `register`。

</details>

<details>
<summary>四、Cloud 和事件源是另一扇门，不是 CLI 里的 cron</summary>

**Codex Cloud**（`codex cloud exec`）是托管环境里跑**同一套 loop**（s23），不是 App 那套本地调度器搬到云上。ChatGPT web 上还有 Gmail / Slack / GitHub 等**应用事件**触发的 scheduled tasks——官方写明桌面 App、CLI、IDE 扩展都没有这扇门。它们和系统 cron 一样：外面的触发器到点叫一次 loop。教学版只演示时间这一种触发源；消费者（dispatcher）不用改，就能接别的事件。

</details>

<details>
<summary>五、无人值守仍受审批和沙箱约束</summary>

定时任务默认按你的 sandbox 跑，App 在组织策略允许时用 `approval_policy = "never"`（没人盯着点 y/n）。教学版把审批/沙箱收成只读 shell 字符串匹配；真实落地仍走 s03/s04 那套门。

</details>

**一句话**：自动化的核心不是「会跑任务」——那是 s01 就会的——而是「**闹钟在 loop 外面**」。CLI 贡献的是 `codex exec`；App 贡献的是 RRULE 调度 + `cron`/`heartbeat` 两种塞法。教学版把这两条塞法在同一个队列后面跑给你看。

</details>

<!-- translation-sync: zh@v2, en@v2 -->
