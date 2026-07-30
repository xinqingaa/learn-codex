# s16: Team Protocols — 消息要有契约

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s15](../s15_agent_teams/) → [s16](../s16_team_protocols/) → [s17](../s17_autonomous_agents/) → ... → s20
> *"Type the message, correlate by id"* — request / response / broadcast 一套契约。
>
> **Harness 层**：协作 —— Agent 之间的结构化握手。

---

## 问题

s15 的队友能互发消息了，但那是松散的自然语言：一句发过去、一句回过来，没有结构。当 Lead 同时派出去三份活、从两个队友收回三份结果时，它怎么知道**哪份结果对应哪份请求**？靠语气猜吗？

两个场景把问题顶到了明处：**派活**——Lead 把三份任务分给 alice 和 bob，结果回流时需要一个可靠的对号入座；**广播**——「开工了」「收工了」这种话要一声发到所有人，且不需要逐个回执。这两个场景结构是同一套：给消息定型、用 id 关联。

---

## 解决方案

![Team Protocols](images/team-protocols.svg)

新增一个**类型化信封** `Envelope`：`{ id, from, to, kind, payload, replyTo? }`，其中 `kind` 是 `request | response | broadcast`。一个 **Lead** 把工作作为 `request` 路由给指定队友；`broadcast` 一声发给所有人；队友回 `response` 时把 `replyTo` 设成它回答的那个请求的 `id`，Lead 据此把结果**精确配对**回挂起的请求。

三种消息，一套契约：

| kind | 方向 | 需要回执 | 用途 |
|------|------|---------|------|
| `request` | Lead → 指定队友 | 是（一个 `response`） | 分派一份工作 |
| `response` | 队友 → Lead | 否 | 回传结果，`replyTo` 指向请求 id |
| `broadcast` | Lead → 所有人 | 否 | 公告：开工、收工、状态变更 |

---

## 工作原理

四块：信封类型、按 kind 派发的队友循环、以及 Lead 的路由 + 配对。

**第 1 步**：信封就是契约。`id` 是贯穿全链路的关联键——请求带着它出去，响应带着它回来（存在 `replyTo` 里）。

```ts
type Kind = "request" | "response" | "broadcast";
type Envelope = {
  id: string;          // 唯一 id；响应靠它关联请求
  from: string;
  to: string;          // 队友名，广播时是 "*"
  kind: Kind;
  payload: string;
  replyTo?: string;    // 响应专用：它回答的那个请求的 id
};
```

**第 2 步**：总线按 `kind` 路由。广播复制给每个已注册邮箱（不回声给发送者），其余点对点投递。

```ts
send(env: Envelope): void {
  const targets = env.kind === "broadcast" ? [...this.boxes.keys()] : [env.to];
  for (const t of targets) {
    if (t === env.from) continue;                 // 广播不回声给发送者
    this.boxes.set(t, [...(this.boxes.get(t) ?? []), env]);
  }
}
```

**第 3 步**：队友循环按 `kind` 分发。`broadcast` 只需记下、不必回；`request` 则干活、回一个 `response`，并把 `replyTo` 设成请求 id。

```ts
if (env.kind === "broadcast") { /* 记下，无需回执 */ continue; }
if (env.kind === "request") {
  const result = await runWork(name, env.payload, scratch);
  BUS.send({
    id: nextId("resp"), from: name, to: env.from,
    kind: "response", payload: result,
    replyTo: env.id,                               // 关联回那个请求
  });
}
```

**第 4 步**：Lead 路由工作、按 `replyTo` 配对响应，把挂起请求标为已完成。

```ts
async collect(total: number): Promise<void> {
  let got = 0;
  while (got < total) {
    const env = await BUS.recv(this.name, 15_000);
    if (!env || env.kind !== "response" || !env.replyTo) continue;
    const req = this.pending.get(env.replyTo);     // 对号入座
    if (!req) continue;                            // 未知 id 的响应：忽略
    req.result = env.payload;
    got++;
  }
}
```

核心洞察：**一个 id 串起整次往返**。请求带 `req_002` 出去，响应带 `replyTo: "req_002"` 回来，Lead 的挂起账本上 `req_002` 就此勾销。松散的自然语言做不到这点——三条回复同时涌进来时，没有 id 就分不清谁答谁。而三种 `kind` 共用一个信封、一套派发分支：加一种新的协调原语（比如审批、关机握手），只是再加一个 `kind` 和一个分支，契约本身不变。

---

## 试一下

> **教学 demo 提示**：代码会在系统临时目录（`os.tmpdir()`）下建一个 `s16-team-*` scratch 目录并写入各小节文件，不碰你的项目文件。

**无需 API key 也能跑**：本章是**自运行演示**，没有 REPL。没有 `OPENAI_API_KEY` 时用内置的离线脚本化模型——Lead 广播开工、派三份活给两个队友、按 id 收齐三份回执，全程打印旁白。

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
3. 在 `collect` 里临时打印 `env.replyTo`，直观感受响应与请求的配对键。

观察重点：每条 `response` 的 `replyTo` 是否精确指向某个 `request` 的 `id`？广播为什么不需要回执？Lead 账本上三份请求如何逐一从 PENDING 变 fulfilled？

---

## 接下来

s15–s16 里，Lead 必须亲手给每个队友派活：「alice 做这个，bob 做那个」。任务板上有 10 份待领的活，Lead 就得派 10 次——这本身成了瓶颈。

能不能让队友**自己看板、自己认领**？Lead 只负责创建任务，队友自己发现、自己抢、自己干、自己交。

s17 Autonomous Agents → 自组织的工人，不再需要领导派活。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于多 Agent 协调的通行架构，并对照 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`）的整体思路。教学版的「类型化信封 + id 关联」是团队契约的最小骨架；真实实现把消息 schema、状态机和门控做成了生产级。

**教学版的信封 ≈ 真实系统里的结构化协议消息。** 差异主要在 schema 校验与状态追踪。

<details>
<summary>一、松散 dict vs 带 schema 的消息</summary>

教学版的信封是一个 TypeScript 类型——靠编译期检查约束形状。真实系统里协议消息通常是**带运行时校验的结构化数据**（例如用 Zod / JSON Schema 定义），非法消息在边界就被拒绝，而不是流到处理分支才出错。教学版省掉运行时校验，专注「id 关联」这一核心；加上校验只是边界加固，契约结构不变。

</details>

<details>
<summary>二、三种 kind vs 一整套消息类型</summary>

教学版用三种 `kind`（request / response / broadcast）覆盖派活、回执、公告。真实团队系统的消息类型更多：任务分派、空闲通知、审批请求/响应、计划审批、关机握手、权限变更等，各自走独立处理分支。但它们共享教学版演示的同一个机制——**用请求 id 关联一次往返**。教学版的一种配对逻辑对应多种协议，这个简化是成立的。

</details>

<details>
<summary>三、id 关联：教学版与真实一致</summary>

教学版用 `req_002` 出去、`replyTo: "req_002"` 回来的配对方式，正是真实请求-响应协议的通行做法。真实实现里这会配一个**状态机**（pending → approved / rejected / fulfilled），并对重复响应、超时响应做防护（教学版的 `collect` 里「未知 id 的响应：忽略」就是去重 / 防串扰的雏形）。差别只在防护的完备性，关联键的思路完全一致。

</details>

<details>
<summary>四、只演示流程 vs 执行门控</summary>

教学版演示了消息**流程**（派活 → 干活 → 回执），没有实现执行**门控**——比如「未获批准前拦截高风险操作」。真实系统里协调协议往往和权限绑定：队友发起高风险请求后，Lead 显式批准才放行。教学版只建了「请求-响应配对」这层地基，门控是在此之上叠加的策略，s03/s04 讲的审批与沙箱正是那类策略的载体。

</details>

**一句话**：把消息从「一句话」升级成「一份带 id 的契约」，团队协作就从「靠默契」变成「可对账」。三种 kind 共用一个信封、一个 id 串起一次往返——掌握了这层，审批、关机、自组织（下一章）都只是在这张契约上加新的 kind。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
