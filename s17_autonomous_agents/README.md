# s17: Autonomous Agents — 自己看板，自己认领

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s16](../s16_team_protocols/) → [s17](../s17_autonomous_agents/) → [s18](../s18_worktree_isolation/) → ... → s20
> *"Poll the board, claim it yourself"* — Codex 仍是父派活；教学版让工人自己抢 s12 的板。
>
> **Harness 层**：协作 —— 把「谁有空」下放给工人，用一次原子认领兜住并发。

---

## 问题

s15–s16 里通信已经通了，但活还是 root 点名派：三份 `request`，三份带 `replyTo` 的回执。板上若有 10 份待领的活，root 就得派 10 次——**编排方自己成了瓶颈**。它也不知道谁此刻空闲。

Codex Multi-Agent V2 默认就是这种父编排：`spawn_agent` / `followup_task` / `wait_agent`。产品面上，用户不明确要求并行就不会 spawn。CSV 批量派生也是编排方按行**推**出工人，不是工人来**拉**。

那把分配权下放呢？root 只把任务写上 s12 那块教学板，工人自己扫、自己抢。两个空闲工人同时看见同一份 `pending` 时，新问题来了：**怎么保证一份活只被一个人领走？**

---

## 解决方案

![Autonomous Agents](images/autonomous-agents.svg)

每个教学工人跑一个三阶段循环：**WORK**（干刚抢到的活）→ **IDLE**（轮询看板）→ **SHUTDOWN**（板上全做完了就退出）。root 不再点名。

看板对外两个操作：不加锁的纯读 `scan()`，和原子的 `claim()`。竞争是设计的一部分——两人完全可能在同一瞬间 `scan()` 到 `t1`，所以「它现在还空着吗」必须放进 `claim()` 的临界区。输的人诚实认输，回去再扫。

这是教程在 s12 的 `claim` 上**多走的一步**：从「一个模型调工具」变成「两个循环同时伸手」。Codex **没有**这块板，也没有工人自领。

| 概念 | 含义 | 备注 |
|------|------|------|
| `scan()` | 纯读看板，**不加锁** | 两个工人可能同时读到同一份 pending |
| `claim(id, owner)` | 原子认领：**锁内**复查仍空闲，才置 `in_progress` | 临界区里只有一个赢家 |
| race LOST | `claim` 失败（已被抢走） | 重新 `scan()`，不要重抢同一份 |
| `blockedBy` | 依赖没做完就不可认领 | t3 要等 t1、t2 都 `done` |

---

## 工作原理

四块：可认领判定、无锁读、把读-改-写串成原子操作的互斥锁、工人自己的循环。

**第 1 步**：pending、没主、依赖都已 `done`，才算可认领。这是 s12 那条规则，原样搬过来。

```ts
private claimable(t: Task): boolean {
  return (
    t.status === "pending" &&
    !t.owner &&
    t.blockedBy.every((id) => this.tasks.get(id)?.status === "done")
  );
}
```

**第 2 步**：`scan()` 故意不加锁。快，但结果可能已经过时。

```ts
scan(): Task | undefined {
  return this.all().find((t) => this.claimable(t));  // 读完就可能变旧
}
```

**第 3 步**：promise 链当互斥锁。整段「复查 + 置位」挂到链尾，同一时刻只跑一段。这不是 Codex 的 lockfile，只是单进程里演示临界区。

```ts
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
```

**第 4 步**：原子认领。先 `sleep` 撑开读与写之间的缝（竞争窗口），再**在锁内**复查。只有发现它还真空着的那个工人赢。

```ts
async claim(id: string, owner: string): Promise<{ ok: boolean; reason: string }> {
  await sleep(CLAIM_LATENCY_MS);              // TOCTOU 缝：竞争住在这里
  return this.lock.run(() => {
    const t = this.tasks.get(id);
    if (!this.claimable(t))
      return { ok: false, reason: `already ${t.status} (owner: ${t.owner ?? "none"})` };
    t.owner = owner;
    t.status = "in_progress";
    return { ok: true, reason: "claimed" };
  });
}
```

工人循环：

```ts
const task = board.scan();
if (!task) { /* IDLE 或板上全 done → SHUTDOWN */ continue; }
const res = await board.claim(task.id, name);
if (!res.ok) continue;                         // race LOST → 再扫
await runTask(name, task, scratch);            // WORK：自己的上下文
await board.complete(task.id, result);
```

核心洞察：**`scan()` 给你的只是线索，不是承诺。** 唯一算数的检查在 `claim()` 临界区里——这叫 TOCTOU。把复查放进锁里，双认领在结构上被消灭。输的人不必重试同一份，板上自然有下一份。

---

## 试一下

> **教学 demo 提示**：代码会在系统临时目录（`os.tmpdir()`）下建一个 `s17-scratch-*` 目录并写入任务文件，不碰你的项目文件。

**无需 API key 也能跑**：自运行演示。root 只往板上写 t1/t2/t3，alice 和 bob 同时 `scan()` 到 t1，在 `claim()` 里分出胜负，输的人转去领 t2；t3 等前两份 `done` 才开放。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s17_autonomous_agents/code.ts                # 离线 demo 模型
OPENAI_API_KEY=sk-... npx tsx s17_autonomous_agents/code.ts   # 真实模型
```

试试这些改动：

1. 再加一个 `worker("carol", ...)`，看三份活如何被瓜分。
2. 把 `CLAIM_LATENCY_MS` 调到 `200`，加宽竞争窗口，观察更多 `race LOST`。
3. 给看板再加一份无依赖的 `t4`，看它和 t1、t2 一样被并行认领。

观察重点：两人同时 `scan()` 到 t1 时，是否只有一个 `claimed`？输家是不是去领了 t2，而不是卡住或重抢 t1？t3 是不是在 t1+t2 都 `done` 之后才被认领？

---

## 接下来

工人能自组织了，但还挤在**同一个工作目录**里。alice 为她的任务改 `app.txt`，bob 也为他的任务改 `app.txt`——互相覆盖。

s18 Worktree Isolation → 给每份任务一个独立的 git worktree。那才更接近 Codex Cloud 的模型：隔离的执行环境，不是工人认领 API。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`）的 Multi-Agent V2，以及官方文档 [Subagents](https://developers.openai.com/codex/subagents)。对照方式与 s12 相同：源码有父编排的 spawn/wait；**没有**工人自领的任务板。本章把 s12 的 `claim` 放到两个并发循环上，不是把源码里已有的调度器抄短。

**教学版的工人循环 = s12 `TaskBoard` + 教程多写的并发认领。Codex 默认仍是 root 派活。**

<details>
<summary>一、Codex 没有自领，产品默认是父编排</summary>

说清楚「有 / 没有」：

- **Codex 源码有**：`spawn_agent`（立刻返回）、`followup_task` / `assign_task`（`trigger_turn = true`）、`send_message`（不唤醒）、`wait_agent`。空闲 session 等到有 trigger 的信（或 durable sleep）才开一轮。CSV 批量 `spawn_agents_on_csv` 是编排方按行推出工人。
- **Codex 源码没有**：空闲工人轮询共享板、`scan()`、多工人抢同一份 `pending`、以及「输了再扫下一份」。
- **本章额外实现**：两个 named `worker` 循环 + 带竞争窗口的 `claim()`。他们是教学工人，**不是** V2 树上自己认领的 `spawn_agent` 孩子。

官方文档也写了：只有用户（或 `AGENTS.md` / skill）**明确要求**并行时才 spawn。把「谁有空」下放给工人，是教程为了演示 TOCTOU 才走的一步。

</details>

<details>
<summary>二、TaskBoard 仍是 s12 那块教学板</summary>

s12 已经写明：Codex 的计划工具是 `update_plan`，没有 `create_task` / `claim_task` / `owner` / `blockedBy`。本章没有把板升级成 Codex 功能，只是让**两个循环同时调 `claim`**。s15/s16 走的是信箱，没用这块板；这里才第一次把多人放回去。

代码里的 `Mutex` 是进程内 promise 链。真实跨进程看板会用数据库 `UPDATE ... WHERE status='pending'` 或 compare-and-swap。语义（复查+置位必须原子）可以对照；**不要**说成 `codex-rs` 里有一份 lockfile 任务板。

</details>

<details>
<summary>三、Codex Cloud 不是认领 API</summary>

Codex Cloud 把一次任务放到**隔离环境**里跑（下一章 s18 的 worktree 才是那条线）。调度层把作业派给执行槽，是云侧的推，不是 Agent 自己看板抢活。CSV fan-out 同样是父按行 spawn，工人必须 `report_agent_job_result`，仍不是 pull。

教学 demo 用 `sleep(CLAIM_LATENCY_MS)` 人为撑开竞争窗口，好让 `race LOST` 可复现。真实网络延迟天生有缝；防守方式（临界区内复查）可以类比，来源不是 Codex 的认领工具。

</details>

<details>
<summary>四、崩溃回收本章不做</summary>

工人领到一半崩溃、任务卡在 `in_progress`、最多认领 N 次、完成事件落盘——真实调度器要处理，教学版略掉。依赖边仍是 s12 的 `blockedBy`。信箱协议是 s16，隔离目录是 s18，都不在本章叠一层。

</details>

**一句话**：Codex 源码里协作仍是父派活；本章多写的是「两人同时伸手时，认领必须原子」。`scan()` 是线索，`claim()` 才是承诺。

</details>

<!-- translation-sync: zh@v2, en@v2 -->
