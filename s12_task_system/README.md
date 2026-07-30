# s12: 任务系统 — 一块 Agent 能读能写的共享任务板

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s11](../s11_error_recovery/) → `s12` → [s13](../s13_background_tasks/) → `s14` → ... → s20
> *"A board the agent can read and write"* — 目标太大就拆成任务，依赖排好序，谁先谁后板上说了算。
>
> **Harness 层**：协作 —— 把一个大目标拆成有依赖、有状态、可认领的任务图。

---

## 问题

给 Agent 一个真实项目：「搭数据库、写 API、补测试、写文档」。

它用 s05 的 `update_plan` 列了张清单，然后埋头写 API——写到一半发现还没有数据库表，回头补；补测试时发现 API 签名又变了，再回头改。它一直在「想起什么做什么」，顺序全靠自己记。

盖房子不能先盖屋顶再打地基。这些子任务之间有**先后**：写 API 依赖数据库就绪，写测试依赖 API 就绪。而且这张清单只对当前这一次对话有效——换一轮、换一个 Agent，就没了。

问题不在模型不会拆任务，而在**拆解结果只存在模型脑子里**。harness 看不到依赖关系，自然没法在「地基没打就想盖屋顶」时拦一下。

---

## 解决方案

![Task System](images/task-system.svg)

把计划从「模型脑中的念头」升级成一块 **harness 持有的共享任务板**：每个任务是一个结构化对象（`id`、`subject`、`status`、`owner`、`blockedBy`），模型通过五个工具来读板、写板。循环还是 s01 那个循环，只是分发表里多了几个工具：

| 工具 | 作用 | 关键检查 |
|------|------|---------|
| `create_task` | 建一个任务，可声明 `blockedBy` 依赖 | 依赖写进任务对象 |
| `list_tasks` | 列出整板（状态 + 依赖 + 是否被阻塞） | 渲染给模型看 |
| `claim_task` | 认领一个任务，`pending → in_progress` | 被阻塞 / 已被认领则**拒绝** |
| `complete_task` | 标记完成，`in_progress → completed` | 顺带解锁下游任务 |
| `shell` | 真正干活（建表、写代码、跑测试） | 与任务工具交替出现 |

核心规则只有一条：**`blockedBy` 里的依赖没全部 `completed`，这个任务就不许认领**。顺序不再靠模型记性，而是板上的一条硬约束。离线 demo 里你能看到：模型想抢跑认领被阻塞的 `t2`，被任务板直接拒绝；等 `t1` 完成，`t2`、`t4` 自动解锁。

---

## 工作原理

在 s01 循环 + s02 分发表的基础上，加一块任务板，分步来看：

**第 1 步**：定义任务的结构和状态机。三个状态、两个动作，`blockedBy` 是一张依赖图。

```ts
type TaskStatus = "pending" | "in_progress" | "completed";
type Task = { id: string; subject: string; status: TaskStatus;
              owner: string | null; blockedBy: string[] };
// 状态机：pending ──claim──> in_progress ──complete──> completed
```

**第 2 步**：任务板的核心是这条「能不能开始」的判断——依赖全部完成才放行。

```ts
canStart(id: string): boolean {
  const t = this.tasks.get(id);
  if (!t) return false;
  return t.blockedBy.every((dep) => this.tasks.get(dep)?.status === "completed");
}
```

**第 3 步**：`claim` 先做三层检查——存在吗？还是 `pending` 吗？依赖都完成了吗？任一不过就拒绝认领。

```ts
claim(id: string, owner: string): string {
  const t = this.tasks.get(id);
  if (!t) return `Error: no such task ${id}`;
  if (t.status !== "pending") return `Error: ${id} is ${t.status}, cannot claim`;
  if (!this.canStart(id)) return `Error: ${id} is blocked by unfinished ...`;
  t.owner = owner; t.status = "in_progress";
  return `Claimed ${id} (${t.subject})`;
}
```

**第 4 步**：`complete` 除了标记完成，还要扫一遍看谁的 `blockedBy` 因此被满足——把刚解锁的下游任务报告出来。

```ts
complete(id: string): string {
  this.tasks.get(id)!.status = "completed";
  const unblocked = this.list()
    .filter((x) => x.status === "pending" && x.blockedBy.includes(id) && this.canStart(x.id));
  return `Completed ${id}` + (unblocked.length ? ` — unblocked: ...` : "");
}
```

**第 5 步**：把这五个工具注册进分发表，循环本身不变。模型每轮看到工具返回的板面状态，决定下一步认领谁。

```ts
const DISPATCH: Record<string, (args) => string> = {
  create_task: (a) => `Created ${board.create(a.subject, a.blockedBy).id}`,
  list_tasks: () => board.render(),
  claim_task: (a) => board.claim(a.id, "agent"),
  complete_task: (a) => board.complete(a.id),
  shell: (a) => runShell(a.command),
};
```

**核心洞察**：`update_plan` 是模型写给自己的便签，任务板是 **harness 强制执行的规则**。便签可以被模型随手改掉，而 `claim_task` 的拒绝是板上钉钉的——依赖没就绪就是认领不到。把「顺序」从模型的自觉变成 harness 的约束，这正是后面多 Agent 协作（s15–s17）能成立的前提：大家认的是同一块板、同一套规则。

---

## 试一下

> **教学 demo 提示**：离线 demo 会用 `shell` 跑 `echo` 模拟干活，不改任何真实文件。任务板保存在进程内存里，退出即清空（持久化留给 s09 的 rollout）。

**无需 API key 也能跑**：没有 `OPENAI_API_KEY` 时，内置离线模型会把「建一张 4 任务依赖板 → 抢跑被拒 → 按序认领干活 → 解锁下游」完整演一遍。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s12_task_system/code.ts                # 离线 demo 模型
OPENAI_API_KEY=sk-... npx tsx s12_task_system/code.ts   # 真实模型
```

试试这些 prompt：

1. `Set up the database, build the API on top of it, then test and document it`
2. `Plan a small web app: scaffold, implement, test — with the right order`
3. `Break "migrate this repo to TypeScript" into tasks and start the first one`

观察重点：模型第一次认领被阻塞的任务时，任务板是不是拒绝了它？完成一个任务后，`list_tasks` 里哪些任务的 `[blocked]` 标记消失了？

---

## 接下来

任务板解决了「先做什么后做什么」。但有些任务本身要跑很久——全量测试、构建、部署。模型调用按 token 计费，干等一个慢命令是在烧钱。

s13 Background Tasks → 把慢操作丢到**后台**跑：Agent 不等它，继续推理别的事，等后台跑完了再在后续某一轮把结果收回来。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构。教学版的任务板是把「计划」做成了一张带依赖的图；Codex 内建最接近的机制是 `update_plan`，差异在持久化与依赖强制上。

**教学版的 `TaskBoard` ≈ Codex 计划工具的「依赖加强版」。** 下面逐项对照。

<details>
<summary>一、Codex 内建的是 update_plan，不是完整任务板</summary>

Codex 给模型的内建计划工具是 `update_plan`（见 s05）：模型把一整份步骤列表（每项带 `pending / in_progress / completed` 状态）重写发回，核心 turn 循环在 harness 内部直接处理它、更新会话状态，**不走沙箱也不落地执行**。它有状态、有进度，但**没有 `blockedBy` 依赖图、没有 owner、没有「拒绝认领」的强制**。教学版的任务板正是在 `update_plan` 的状态机之上，加了依赖检查这一层硬约束——这是教学上的进阶，不是 Codex 原生功能的复刻。

</details>

<details>
<summary>二、依赖强制是教学版加的关键一层</summary>

Codex 的 `update_plan` 只表达「我现在做到哪一步」，不阻止模型跳着做。教学版的 `claim_task` 加了一条 Codex 计划工具没有的规则：`blockedBy` 没全部完成就**拒绝认领**。这条「harness 强制执行顺序」的思路，更接近多 Agent 编排里的任务调度——在 Codex Cloud / 多 Agent 场景里，一个目标被拆成若干子任务分给不同 Agent 时，谁先谁后必须由一个共享的真相来源来裁决，而不是靠各个 Agent 自觉。教学版用单 Agent 把这块「共享板」先建起来，s15–s17 会让多个 Agent 认它。

</details>

<details>
<summary>三、状态放哪：内存 vs rollout</summary>

教学版把任务板放在进程内存里，退出即清空。Codex 的会话状态（包括 `update_plan` 那份计划）会随 **rollout** 持久化（见 s09），所以 `codex resume` 恢复一条长会话时，没做完的计划也能回来。也就是说：Codex 里「计划/状态」的持久化走会话 rollout 这条路；教学版刻意把任务板做成纯内存，是为了让读者聚焦「依赖检查」这一个新机制，持久化留给 s09 再叠加。

</details>

<details>
<summary>四、为什么是「工具」而不是「关键字」</summary>

教学版和 Codex 都把任务操作做成**模型可调用的工具**，而不是 harness 解析的特殊语法。好处一致：模型用和调 `shell` 一样的方式调 `create_task` / `claim_task`，工具结果就是板面状态，天然进上下文、可被模型继续推理。区别只在处理位置——`update_plan` 这类内建工具由核心循环直接处理，而 `shell` 这类要经过审批 + 沙箱。教学版的 `DISPATCH` 表把两类都装进去了，和 s02 的注册表一脉相承。

</details>

**一句话**：教学版的任务板 = Codex `update_plan` 的状态机 + 一层依赖强制 + （留给 s09 的）持久化。它把「先做什么」从模型的自觉变成 harness 的规则——这是让多个执行者能对同一份计划协作的最小前提。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
