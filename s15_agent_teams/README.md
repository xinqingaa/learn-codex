# s15: Agent Teams — 各带上下文，信箱通信

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s14](../s14_automations/) → [s15](../s15_agent_teams/) → [s16](../s16_team_protocols/) → ... → s20
> *"Split the task across teammates, not across one context"* — `spawn_agent` 立刻返回，信箱传信息。
>
> **Harness 层**：协作 —— 一棵 Agent 树，各持上下文，由 mailbox 相连。

---

## 问题

「重构整个后端」涉及认证模块、数据库层、API 路由、测试。一个 Agent 在改路由时，认证模块的细节早被挤出上下文了——窗口就那么大，单个 Agent 的注意力盖不住所有模块。

s06 的子 Agent 是临时工：叫来干一件事，交出结论就销毁。那能隔离一次跑偏（干净上下文、只回传结论），但扛不住需要**并行、持续、中途互传信息**的任务。s12 的任务板解决的是「先做什么后做什么」，也不是通信。你需要的是能通信、能并行干活、各自保住自己上下文的队友——一个研究、一个写作，互不挤占对方的窗口，只把对方需要的那点东西递过去。

---

## 解决方案

![Agent Teams](images/agent-teams.svg)

对照 Codex **Multi-Agent V2**，本章加上三件东西：进程内 **Mailbox**（每个 Agent 一个收件箱）、**非阻塞的 `spawn_agent`**（立刻返回 `task_name`，子循环自己跑）、以及作为工具的 **`send_message` / `wait_agent`**。教学版的 `root` 在同一轮并行拉起 `researcher` 和 `writer`；researcher 把精炼结论塞进 writer 的信箱；孩子收工时 harness 自动往父信箱投一封 `final`，root 用 `wait_agent` 接手。

s06 子 Agent vs s15 队友：

| | s06 子 Agent | s15 Multi-Agent V2 |
|---|---|---|
| 派生 | `spawnSubagent`：父 `await` 到子结束 | `spawn_agent` **立刻返回**，子并行跑 |
| 生命周期 | 一次性，交结论即销毁 | 多轮，活到任务结束 |
| 通信 | 只回传一次结果 | `send_message` 随时入队；收工投 `final` |
| 等待 | 派生那一次调用本身 | `wait_agent` 阻塞在**自己的**信箱上 |
| 拓扑 | 主从，父等子 | 树：`root` + 命名孩子 |

三件协作工具对上真实 Codex 的名字：

| 工具 | 做什么 |
|---|---|
| `spawn_agent` | 按 `task_name` 开一个新上下文；**不**等它跑完 |
| `send_message` | 把消息**排队**进目标信箱，**不**替对方开一轮 |
| `wait_agent` | 阻塞到本 Agent 信箱有更新（来信或孩子的 `final`），带超时 |

---

## 工作原理

四块：信箱、三件协作工具、孩子循环在收工时投 `final`、root 并行派生再 join。

**第 1 步**：信箱是进程内通道。`send` 追加——若对方正阻塞在 `wait_agent` 上就直接交付，否则入队；`recv` 阻塞等待（带超时，防止挂死）。这就是 `codex-rs` 里 `Mailbox` 的最小骨架：内存队列 + 唤醒，**不是**每个 Agent 一个磁盘文件。

```ts
class Mailbox {
  private boxes = new Map<string, Mail[]>();
  private waiters = new Map<string, Array<(m: Mail) => void>>();

  send(from: string, to: string, content: string): void {
    const pending = this.waiters.get(to);
    if (pending?.length) pending.shift()!(mail);   // 有人正等 → 直接交付
    else this.boxes.get(to)!.push(mail);           // 否则入队
  }

  async recv(to: string, timeoutMs = 15_000): Promise<Mail | null> {
    const box = this.boxes.get(to)!;
    if (box.length > 0) return box.shift()!;
    return new Promise((resolve) => { /* 阻塞到有信或超时 */ });
  }
}
```

**第 2 步**：派生、发信、等信都是普通 Responses API 函数工具。作用在**另一个 Agent 的上下文**上，不是文件系统。`spawn_agent` 只登记孩子、立刻返回；同一轮里的多次 spawn 先全部登记完再启动，避免 writer 的信箱还没建好。

```ts
if (name === "spawn_agent") {
  if (self !== "root") return "only the root agent can spawn";
  BUS.ensure(args.task_name);
  pendingSpawns.push({ name: args.task_name, task: args.message, parent: self });
  return `spawned ${args.task_name}`;            // 立刻返回，不 await 子循环
}
if (name === "send_message") { BUS.send(self, args.target, args.message); return `queued for ${args.target}`; }
if (name === "wait_agent") {
  const msg = await BUS.recv(self);               // 阻塞在自己的信箱
  return msg ? `[mailbox from ${msg.from}] ${msg.content}` : "(mailbox timeout)";
}
```

**第 3 步**：每个 Agent 仍是 s01 那个循环，各持一份私有 `input`。孩子工具表更窄（没有 `spawn_agent`，防止递归）。循环结束时 harness **自己**往父信箱投 `final`——对应 Codex 的 `FINAL_ANSWER`，不是模型再调一次工具。

```ts
async function runAgent(name, role, task, scratch) {
  const input: unknown[] = [{ role: "user", content: task }];   // 私有上下文
  for (let step = 0; step < 8; step++) {
    const output = await callModel(input, role);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) break;                             // 该 Agent 收工
    for (const c of calls) { /* 派发工具，结果写回这份 input */ }
    flushSpawns(scratch);                                      // 本轮 spawn 登记完再启动
  }
  const parent = parentOf.get(name);
  if (parent) BUS.send(name, parent, `final: ${closing}`);     // FINAL_ANSWER
}
```

**第 4 步**：root 在同一轮并行 `spawn_agent` 两个孩子，然后 `wait_agent` 两次收两封 `final`。researcher 的原始笔记从未进入 writer 或 root 的窗口——过境的只有 `send_message` 的那句结论，和收工时的 `final`。

```ts
// root 的第一轮（离线剧本）：两次 spawn 打在同一 turn 里
spawn_agent({ task_name: "researcher", message: "… send_message findings to writer." })
spawn_agent({ task_name: "writer",     message: "wait_agent for findings, write the doc." })
```

核心洞察：**队友之间共享的是信息，不是上下文**。`spawn_agent` 把「另开一个终端」变成可并行的命名线程；信箱强迫任何过境的东西必须被说出来。`researcher` 可以看完几十条笔记，只把一句结论发给 `writer`；root 的窗口里甚至没有那句结论，只有两封 `final`。没有中央调度器在编排步骤——发信、等信、收工投递，几个循环自己完成交接。

---

## 试一下

> **教学 demo 提示**：代码会在系统临时目录（`os.tmpdir()`）下建一个 `s15-team-*` scratch 目录并写入 `agent-loop.md`，不碰你的项目文件。

**无需 API key 也能跑**：本章是**自运行演示**，没有 REPL。没有 `OPENAI_API_KEY` 时用内置的离线脚本化模型——`root` 并行 spawn 两个孩子，走完「研究 → 发信 → 等信 → 写作 → 两封 final」的交接。

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

1. 用真实 key 跑一遍，看 `researcher` 如何用自然语言措辞那封 `send_message`。
2. 让 `writer` 在写完后再 `send_message` 给 `root`（不只靠 harness 的 `final`），观察 root 信箱里多出来的那一行。
3. 把 `recv` 的 `timeoutMs` 调小，看 `(mailbox timeout)` 如何防止挂死。

观察重点：`spawn_agent` 打印之后孩子立刻 `online`，root 并没有等他们跑完才返回；`writer` 收到的只是那句 findings，不是 researcher 的笔记；root 最后两封是 `final:`，由 harness 投递。

---

## 接下来

队友能派生、能通信了，但信还是松散的自然语言：一句发过去、一句回过来，没有「这条回复对应哪条请求」。root 同时派三份活、收回三份结果时，靠语气是对不上账的。

s16 Team Protocols → 给消息套上类型化信封（request / response / broadcast），让一个 Lead 路由工作、按 id 收集结果。那对应 Codex 信封上的 `NEW_TASK` / `MESSAGE` / `FINAL_ANSWER`，以及用 id 把一次往返串起来。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的 Multi-Agent V2，以及官方文档 [Subagents](https://developers.openai.com/codex/subagents)。教学版是这套「命名子线程 + 进程内信箱」的最小骨架；真实实现补上了生命周期、路径寻址、唤醒策略和会话隔离。

**教学版的 root + `spawn_agent` / `send_message` / `wait_agent` ≈ Codex Multi-Agent V2。** 不是「子代理再加一个通用多智能体总线」，就是 Codex 自己这套协作工具。

<details>
<summary>一、spawn_agent 立刻返回：这是相对 s06 的真正升级</summary>

s06 的 `spawnSubagent` 在父循环里 `await agentLoop(subInput)`——父等到子交结论。那一章的工具碰巧也叫 `task`，但**不是** s12 的任务板（`create_task` / `claim_task`）。Codex 的 `spawn_agent`（见 `codex-rs/tools` 的 agent 工具表）**立刻**返回规范任务名（V2 形如 `/root/worker` 的 `AgentPath`），子线程在自己的 session 里跑。父要用 `wait_agent` 才能 join。教学版用短名 `researcher` / `writer` 代替完整路径，并禁止孩子再 spawn（收窄工具表）——真实系统允许嵌套派生，但有并发线程上限（`agents.max_concurrent_threads_per_session`）。

产品面上，当前 Codex 默认在用户（或 `AGENTS.md` / skill）**明确要求**并行委派时才 spawn；每个子 Agent 自己烧 token，所以比单 Agent 贵。内置角色有 `default` / `worker` / `explorer`，也可以在 `~/.codex/agents/` 或 `.codex/agents/` 下放 TOML 自定义（`name`、`description`、`developer_instructions`，以及可选的 `model` / `sandbox_mode`）。教学版把角色写进 prompt，不解析 TOML。

</details>

<details>
<summary>二、Mailbox 是进程内通道，不是 inbox 文件</summary>

真实实现是 `codex-rs` 核心里的 `Mailbox`：tokio `mpsc` + 单调序号 + `watch` 通道，用来唤醒正在 `wait_agent` 的调用方。发信入队并 bump seq；接收端 drain。会话历史走 rollout 落盘（s09），**信箱本身不是**「每个 Agent 一个 JSONL 文件」。教学版的 `Map` + `waiters` 就是这个内存通道；进程退出即清空。若把信箱画成磁盘文件，那是另一种多智能体架构，不是 Codex。

</details>

<details>
<summary>三、send_message 不唤醒一轮；followup 才 trigger_turn</summary>

`InterAgentCommunication` 带 `author`、`recipient`、`content` 和 `trigger_turn`。`send_message` 把 `trigger_turn` 设为 false：消息入队，**不**给空闲的对方新开一轮。要对方立刻干活，真实工具面是 `followup_task` / `assign_task`（`trigger_turn = true`）。空闲 session 在有 trigger 的邮件（或 durable sleep）时才 `maybe_start_turn_for_pending_work`。

教学版把「排队」和「对方正阻塞在 wait_agent 上所以被直接交付」合成一个 `send`：demo 里 writer 一开始就在等，不必单独演示 `followup_task`。真实系统里这两种投递必须分开——闲聊进信箱不该立刻烧一轮模型。

投递给模型时，V2 会渲染明文信封头：`NEW_TASK`（开一轮，含初次 spawn 和后续 followup）、`MESSAGE`（排队的 `send_message`）、`FINAL_ANSWER`（孩子到达终态）。教学版的 `final:` 前缀就是 `FINAL_ANSWER` 的缩写；结构化的 `kind` / `id` / `replyTo` 留给 s16。

</details>

<details>
<summary>四、wait_agent：教学版等自己的信箱，真实 V2 等「有更新」</summary>

教学版的 `wait_agent` 阻塞在**调用者自己的**信箱上，有信就返回全文，超时返回 `(mailbox timeout)`。这是最直白的 join。

Codex V1 的 `wait_agent` 带 `targets`，等指定孩子到终态，完成状态里可以带最后一句话。V2 改为等 mailbox 序号变化：返回的是「等到了 / 超时了」的摘要，**不一定把信件正文塞进 tool result**——正文会作为信封出现在接收方后续 turn 的输入里。教学版为了让离线剧本一眼看见「writer 拿到了 findings」，选择把正文放进 tool output。两种都是「没信就挂起，有信就醒」，接进主事件循环的方式不同。

</details>

<details>
<summary>五、拓扑是树，产品默认由 root 编排</summary>

寻址是 `AgentPath`（`/root/researcher`）。`send_message` 可以打给树上任何一个仍活着的 Agent，所以同学之间**可以**直发——教学 demo 的 researcher → writer 就是这条能力。但产品默认仍是 **root 编排**：spawn、wait、汇总；孩子的 `FINAL_ANSWER` 投给**父**（一跳），不是广播给整棵树。nested 孙节点完成时，祖父不会自动在自己的 `wait_agent` 里看到——父必须继续等、再往上转。教学版没有嵌套，root 收两封孩子 `final` 就结束。

真实工具面还有 `list_agents`、`close_agent`、`resume_agent`，以及可选的 `fork_context` / `fork_turns`（把父历史抄进孩子）。教学版不实现生命周期与 fork，只保留「干净的新 `input`」。CLI 用 `/agent` 在线程间切换；审批请求可以从后台子线程冒泡到你正在看的主线程。

</details>

**一句话**：一个队友 = 一份自己的上下文 + 一个自己的 agent loop + 一个信箱；`spawn_agent` 让他活着并行，`send_message` / `wait_agent` 让信息不合并窗口。真正的难点不在「让两个循环跑起来」，而在交接是否可靠、能否对账——那正是下一章协议要解决的。

</details>

<!-- translation-sync: zh@v2, en@v2 -->
