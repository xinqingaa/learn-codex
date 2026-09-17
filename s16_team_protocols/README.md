# s16: Team Protocols — 消息要有契约

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s15](../s15_agent_teams/) → [s16](../s16_team_protocols/) → [s17](../s17_autonomous_agents/) → ... → s20
> *"Type the message, correlate by id"* — Codex 的头是 `NEW_TASK` / `MESSAGE` / `FINAL_ANSWER`；教学版再加上 `replyTo` 账本。
>
> **Harness 层**：协作 —— 信封把松散的信变成可对账的契约。

---

## 问题

s15 的信箱已经能把字送过去：`send_message` 入队，`wait_agent` 取出，孩子结束时 harness 再投一封 `final:`。信还是**一句话**。root 同时派三份活、从 alice 和 bob 收回三份结果时，靠语气是对不上账的。

s12 的任务板解决的是「先做什么后做什么」，不是「这封回信答的是哪条请求」。通信和任务板是两层。

Codex 自己其实已经给投进模型的信加了头：`NEW_TASK`、`MESSAGE`、`FINAL_ANSWER`。它**没有**「按请求 id 同时对上 N 路往返」这一层——寻址靠 Agent 路径，完成通知一跳给父。教学版要演示的，正是源码里缺的那本账。

---

## 解决方案

![Team Protocols](images/team-protocols.svg)

在 s15 的进程内 `Mailbox` 上套一层**类型化信封** `Envelope`：`{ id, from, to, kind, payload, replyTo?, triggerTurn }`。`kind` 仍用教学名 `request | response | broadcast`，对应关系写清楚，不假装 Codex 也叫这三个名字。

| 教学 kind | 对应 Codex | `triggerTurn` | 教学额外 |
|-----------|------------|---------------|----------|
| `request` | `NEW_TASK` / `followup_task`（唤醒对方干活） | `true` | root 把 `id` 记进挂起账本 |
| `response` | 孩子结束时 harness 投的 `FINAL_ANSWER` | `false` | `replyTo` 指回那条请求 |
| `broadcast` | **没有**这种 kind | `false` | 扇出给每个已注册邮箱，不回执 |

一个 **root** 把工作当成 `request` 打给指定孩子；孩子干完后 harness 回 `response`；root 用 `replyTo` **精确配对**。`broadcast` 一声发给所有人（开工 / 收工），这是教程加的，不是 Codex 协议。

---

## 工作原理

四块：信封字段、带 waiter 的信箱、按 kind 分发的工人循环、root 的挂起账本。

**第 1 步**：信封就是契约。Codex 的 `InterAgentCommunication` 有 `author` / `recipient` / `content` / `trigger_turn`。教学版对齐这些，再多两个教学字段：`kind` 和 `replyTo`。

```ts
type Envelope = {
  id: string;
  from: string;
  to: string;          // 队友名；广播时是 "*"
  kind: Kind;          // 教学名，不是 Codex 枚举
  payload: string;
  replyTo?: string;    // 教学额外：响应关联回请求
  triggerTurn: boolean; // request = true；MESSAGE / FINAL_ANSWER = false
};
```

**第 2 步**：信箱仍是 s15 那套 waiter（有人在等就直接交付，否则入队），只是载荷从字符串换成信封。广播复制到每个已注册邮箱，不回声给发送者。

```ts
send(env: Envelope): void {
  const targets = env.kind === "broadcast" ? [...this.boxes.keys()] : [env.to];
  for (const t of targets) {
    if (t === env.from) continue;
    const pending = this.waiters.get(t);
    if (pending && pending.length > 0) pending.shift()!(env);
    else this.boxes.get(t)!.push(env);
  }
}
```

**第 3 步**：工人按 `kind` 分发。`broadcast` 记下、不必回；`request` 干活。回执由 **harness** 投递（对应 Codex 在孩子终态贴 `FINAL_ANSWER`），并带上教学用的 `replyTo`。

```ts
if (env.kind === "broadcast") { /* 记下；收工则退出 */ continue; }
if (env.kind === "request") {
  const result = await runWork(name, env.payload, scratch);
  BUS.send({
    id: nextId("final"), from: name, to: env.from,
    kind: "response", payload: result,
    replyTo: env.id, triggerTurn: false,
  });
}
```

**第 4 步**：root 把每条 `request` 记进 `pending`，收信时用 `replyTo` 勾账。未知 id 直接丢掉——并发时的去重 / 防串扰。

```ts
async collect(total: number): Promise<void> {
  let got = 0;
  while (got < total) {
    const env = await BUS.recv(this.name, 15_000);
    if (!env || env.kind !== "response" || !env.replyTo) continue;
    const req = this.pending.get(env.replyTo);
    if (!req) continue;            // 未知 id：忽略
    req.result = env.payload;
    got++;
  }
}
```

核心洞察：**Codex 用头区分这封信是什么；教学版用 `replyTo` 区分它回答的是哪一次请求。** 三条回复同时涌进 root 信箱时，没有 id 就分不清谁答谁。真实 Codex 不需要这本账：父通常一次等一个孩子，完成通知按 Agent 路径一跳给父，而不是「N 条 in-flight 请求对 N 条回执」。`broadcast` 也是教程加的——Codex 没有全员公告 kind。

---

## 试一下

> **教学 demo 提示**：代码会在系统临时目录（`os.tmpdir()`）下建一个 `s16-team-*` scratch 目录并写入各小节文件，不碰你的项目文件。

**无需 API key 也能跑**：本章是**自运行演示**，没有 REPL。没有 `OPENAI_API_KEY` 时用内置的离线脚本化模型——root 广播开工、派三份活、丢掉一封未知 `replyTo`、按 id 收齐三份回执，全程打印旁白。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s16_team_protocols/code.ts                # 离线 demo 模型
OPENAI_API_KEY=sk-... npx tsx s16_team_protocols/code.ts   # 真实模型
```

试试这些改动：

1. 用真实 key 跑一遍，看模型如何为不同的小节标题产出不同的 `write_file` 内容。
2. 再 `request` 一份活给 bob，把 `collect(3)` 改成 `collect(4)`，观察账本。
3. 把那封 `replyTo: "req_999"` 的幽灵响应删掉，对比 `ignored` 那一行还在不在。

观察重点：每条 `response` 的 `replyTo` 是否精确指向某个 `request` 的 `id`？未知 id 为什么被忽略？广播为什么不需要回执？账本上三份请求如何从 PENDING 变成 fulfilled？

---

## 接下来

s15–s16 里，root 必须亲手给每个队友派活：「alice 做这个，bob 做那个」。任务板上有 10 份待领的活，root 就得派 10 次——编排方自己成了瓶颈。

能不能让队友**自己看板、自己认领**？root 只负责创建任务，队友自己发现、自己抢、自己干、自己交。

s17 Autonomous Agents → 工人自己扫 s12 那块教学板、原子认领。Codex 默认仍是父派活（`spawn_agent` / `followup`）；并发抢板是教程多写的一层。Cloud 隔离留给 s18，不是认领 API。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的 Multi-Agent V2，以及官方文档 [Subagents](https://developers.openai.com/codex/subagents)。对照方式与 s12 相同：源码有信封头和 `trigger_turn`；**没有** `replyTo` 对 N 路请求、也没有 `broadcast` kind。本章多写的是账本，不是把源码里已有的协议抄短。

**教学版的信封 = Codex `InterAgentCommunication` + 模型可见的头 + 教程多写的 `replyTo` 账本。**

<details>
<summary>一、真实信封没有 kind，也没有 replyTo</summary>

Codex 的 `InterAgentCommunication` 大致是：可选通信 `id`、`author` / `recipient`（`AgentPath`，形如 `/root/worker`）、`other_recipients`、`content`、可选 `encrypted_content`、以及 `trigger_turn`。投递给模型时渲染明文头：

- `NEW_TASK`：开一轮（初次 spawn 和后续 `followup_task` / `assign_task`），`trigger_turn = true`
- `MESSAGE`：`send_message` 入队，`trigger_turn = false`，不给空闲对方新开一轮
- `FINAL_ANSWER`：孩子到达终态，由 **harness** 投给父（一跳），不是孩子自己选一个 `kind: "response"`

没有 `request | response | broadcast` 这组枚举。教学版用这三个名字，是为了让「派活 / 回执 / 公告」在 200 行里分发得清楚，**不是** Codex API。

</details>

<details>
<summary>二、replyTo 对 N 路，是教程多写的一层（像 s12 的 claim_task）</summary>

说清楚「有 / 没有」：

- **Codex 源码有**：按 Agent 路径寻址、信箱序号、`wait_agent` 等到有更新、完成通知给父。
- **Codex 源码没有**：`replyTo`、挂起请求 Map、「三条 in-flight 请求对三条回执」的相关性、以及「未知 id 的响应：忽略」这套去重。
- **本章额外实现**：`pending` 账本 + `replyTo`。它不是「把源码里已有的请求-响应协议简化了」，而是教学上**多走一步**——并发派活时必须对账。

真实产品默认仍是 root 编排、一次关注一个（或少数）孩子；父很少需要「N 个请求 id 对 N 个结果」。教学 demo 故意同时派三份，让这本账变得必要。

</details>

<details>
<summary>三、broadcast 也是教学加的</summary>

Codex 完成通知是**一跳给父**，不是扇出给整棵树。`other_recipients` 可以抄送，但没有「to: `*`、全体邮箱、无需回执」这种 kind。教学版的开工 / 收工广播只是为了让「不必回执的公告」和「必须回执的 request」共用一个信封，好对比。不要把它画成 A2A 的广播，也不要画成 MCP。

</details>

<details>
<summary>四、信箱还是进程内 waiter，不是轮询</summary>

s15 已经把 `Mailbox` 做成 Map + waiters（对应 `codex-rs` 里 tokio mpsc + seq + watch）。旧教学版用 20ms `sleep` 轮询收件箱，那不是 Codex。本章沿用 waiter：有人阻塞在 `recv` 上就直接交付。协议加在信封上，不加在传输层上。

生命周期工具（`list_agents` / `close_agent` / `resume_agent`）和加密字段本章不实现。认领任务是 s17，审批门控仍在 s03/s04，不新开一种 `kind`。

</details>

**一句话**：Codex 源码里的协议是信封头 + `trigger_turn`（信是什么、要不要开一轮）；本章多写的是 `replyTo` 账本（这封回信答的是哪条请求）。两者都挂在 s15 同一条信箱上，都不是第二套循环。

</details>

<!-- translation-sync: zh@v2, en@v2 -->
