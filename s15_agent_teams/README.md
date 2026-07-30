# s15: Agent Teams — 各带上下文，信箱通信

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s14](../s14_automations/) → [s15](../s15_agent_teams/) → [s16](../s16_team_protocols/) → ... → s20
> *"Split the task across teammates, not across one context"* — 异步信箱 + 命名队友。
>
> **Harness 层**：协作 —— 多 Agent 各持上下文，消息总线相连。

---

## 问题

「重构整个后端」涉及认证模块、数据库层、API 路由、测试。一个 Agent 在改路由时，认证模块的细节早被挤出上下文了——上下文窗口就那么大，单个 Agent 的注意力盖不住所有模块。

s06 的子 Agent 是临时工：叫来干一件事，交出结论就销毁。但有些任务需要的是**能通信、能并行干活、各自保住自己上下文**的队友。一个研究、一个写作，互不挤占对方的窗口，只把对方需要的那点东西递过去。

---

## 解决方案

![Agent Teams](images/agent-teams.svg)

新增两样：**MessageBus**（每个队友一个异步信箱）和**队友循环**（每个命名 Agent 各持一份私有上下文，跑各自的 agent loop）。发消息就是一个工具调用 `send_message`，等消息就是 `wait_inbox`——阻塞直到有信送达。教学版让 `researcher` 研究、`writer` 写作，靠信箱完成交接。

子 Agent vs 队友：

| | s06 子 Agent | s15 队友 |
|---|---|---|
| 生命周期 | 一次性，用完即销毁 | 多轮，持续到任务完成 |
| 上下文 | 与父级隔离，只回传结论 | 各自私有，靠消息共享信息 |
| 通信 | 只回传一次结果 | 异步信箱，随时互发 |
| 关系 | 主 Agent + 偶尔子 Agent | 对等的命名队友 |

---

## 工作原理

三块：信箱总线、作为工具的发/收消息、以及每个队友自己的循环。

**第 1 步**：信箱总线。`send` 追加消息——若对方正阻塞在 `wait_inbox` 上就直接交付，否则入队；`recv` 阻塞等待（带超时兜底，防止真实运行时挂死）。

```ts
class MessageBus {
  private boxes = new Map<string, Message[]>();
  private waiters = new Map<string, ((m: Message) => void)[]>();

  send(from: string, to: string, content: string): void {
    const msg = { from, to, content, ts: Date.now() };
    const pending = this.waiters.get(to);
    if (pending?.length) pending.shift()!(msg);   // 有人正等 → 直接交付
    else this.boxes.set(to, [...(this.boxes.get(to) ?? []), msg]);
  }

  async recv(to: string, timeoutMs = 15_000): Promise<Message | null> {
    const box = this.boxes.get(to);
    if (box?.length) return box.shift()!;
    return new Promise((resolve) => { /* 阻塞到有信或超时 */ });
  }
}
```

**第 2 步**：发/收消息就是工具。`send_message` 和 `wait_inbox` 注册成普通的 Responses API 函数工具，由 harness 像执行其他工具一样派发——但作用的是**另一个 Agent 的上下文**，不是文件系统。

```ts
if (name === "send_message") { BUS.send(self, args.to, args.content); return `delivered to ${args.to}`; }
if (name === "wait_inbox") {
  const msg = await BUS.recv(self);                       // 阻塞等信
  return msg ? `[inbox from ${msg.from}] ${msg.content}` : "(inbox timeout)";
}
```

**第 3 步**：每个队友是独立循环，各持私有 `input` 数组（它自己的上下文窗口）。信箱工具让两个循环得以协同。

```ts
async function teammate(name, role, task, scratch) {
  const input: unknown[] = [{ role: "user", content: task }];   // 私有上下文
  for (let step = 0; step < 8; step++) {
    const output = await callModel(input, role);                // 各调各的模型
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) return;                             // 该队友收工
    for (const c of calls) {
      const result = await runTool(c.name, JSON.parse(c.arguments), name, scratch);
      input.push({ type: "function_call_output", call_id: c.call_id, output: result });
    }
  }
}
```

**第 4 步**：并发起跑，交接由信箱驱动。

```ts
await Promise.all([
  teammate("researcher", "researcher", "Research … then send findings to 'writer'.", scratch),
  teammate("writer", "writer", "Wait for findings, write agent-loop.md, tell 'researcher'.", scratch),
]);
```

核心洞察：**队友之间共享的是信息，不是上下文**。`researcher` 可以把几十条原始笔记看完，只把一句精炼结论发给 `writer`；`writer` 的窗口里永远没有那些笔记，只有它需要的那句话。这正是团队能扛大任务的原因——每个人的上下文都小而聚焦，靠消息把必要的信息接力下去。而整个协作没有任何中央调度：发信、等信，两个循环自己就完成了交接。

---

## 试一下

> **教学 demo 提示**：代码会在系统临时目录（`os.tmpdir()`）下建一个 `s15-team-*` scratch 目录并写入 `agent-loop.md`，不碰你的项目文件。

**无需 API key 也能跑**：本章是**自运行演示**，没有 REPL。没有 `OPENAI_API_KEY` 时用内置的离线脚本化模型——`researcher` 和 `writer` 各按脚本走完「研究 → 发信 → 等信 → 写作 → 回执」的完整交接。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s15_agent_teams/code.ts                # 离线 demo 模型
OPENAI_API_KEY=sk-... npx tsx s15_agent_teams/code.ts   # 真实模型
```

试试这些改动：

1. 用真实 key 跑一遍，看两个队友如何用自然语言措辞那封「findings」邮件。
2. 给 `writer` 的任务加一句「写完后把文件路径发给 researcher」，观察第二轮消息。
3. 把 `recv` 的 `timeoutMs` 调小，看 `(inbox timeout)` 兜底如何防止挂死。

观察重点：两个队友各自只调自己的模型、各持一份 `input`；信箱是唯一的信息通道。`writer` 收到的只是那句结论，不是 researcher 的全部笔记。

---

## 接下来

队友能干活、能通信了，但协调还很松散：`researcher` 发一句、`writer` 回一句，全靠自然语言，没有结构。要是想让 Lead 给队友派活、并确切知道哪份结果对应哪个请求，自然语言就不够用了。

s16 Team Protocols → 给消息套上类型化信封（request / response / broadcast），让一个 Lead 路由工作、按 id 收集结果。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于多 Agent 协作的通行架构，并对照 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`）的子代理机制。教学版的「命名队友 + 异步信箱」是多 Agent 团队的最小骨架；真实实现把生命周期、隔离和持久化做成了生产级。

**教学版的队友 ≈ Codex 的子代理 + 一个共享信箱。** 差异主要在隔离强度和消息投递。

<details>
<summary>一、上下文隔离：教学版天然达成</summary>

教学版每个队友一份私有 `input` 数组，隔离是「天然」的——它们物理上就是两个数组。Codex 的子代理（sub-agent）也是这个思路：子代理拿到一份**全新的、独立的上下文**去执行子任务，只把结论回给主代理，从而不污染主上下文。差别在于真实实现里子代理的上下文有明确的生命周期管理（创建、运行、回收），教学版只演示「各自的数组」这一核心。

</details>

<details>
<summary>二、信箱在内存 vs 落盘</summary>

教学版的 `MessageBus` 是进程内内存队列：直观，但进程一关消息就没了。真实的多 Agent 系统常把信箱**持久化到磁盘**（每个 Agent 一个收件箱文件），发消息 = 追加一行，读消息 = 消费式读取，并用文件锁防并发写冲突。落盘带来的好处是跨进程、跨重启可观察、可恢复——教学版的内存队列省掉了这些，专注「异步交接」这一机制本身。

</details>

<details>
<summary>三、阻塞等信 vs 轮询空闲</summary>

教学版用 `wait_inbox` 让队友**阻塞**到有信送达（带超时兜底）。真实系统里队友干完一轮常进入 **idle 轮询**：周期性地看一眼收件箱，有新消息就再起一轮，没消息就继续等。两种做法殊途同归——都是「没活儿时挂起，有信时唤醒」。教学版的阻塞模型更直白，轮询模型则更省资源、更易于和主事件循环整合。

</details>

<details>
<summary>四、松散消息 vs 结构化协议</summary>

教学版的消息是松散的 `{from, to, content}`——能通信，但没有「这条回复对应哪条请求」的概念。s16 会把它升级成带 `id`、`kind` 的类型化信封，让 Lead 能可靠地路由与配对。真实系统里团队通信同样是结构化的：普通文本、任务分派、审批请求、关机握手等是不同的消息类型，各自走不同的处理分支。

</details>

**一句话**：一个队友 = 一份自己的上下文 + 一个自己的 agent loop + 一个信箱。把这三样凑齐，单 Agent 就变成了团队。真正的难点不在「让两个循环跑起来」，而在它们如何可靠地交接——那正是下一章协议要解决的。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
