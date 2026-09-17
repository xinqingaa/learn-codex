# s18: Worktree Isolation — 一个任务一个目录

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s17](../s17_autonomous_agents/) → [s18](../s18_worktree_isolation/) → [s19](../s19_mcp_servers/) → ... → s20
> *"One task, one directory"* — 并行的手各改各的目录，互不打架。
>
> **Harness 层**：协作 —— 用 git worktree 给本机并行 session 做目录隔离。Cloud 容器是 s23。

---

## 问题

s17 让空闲的工人自己认领任务了，但他们还挤在**同一个工作目录**里。alice 的任务是「设计数据库 schema」，bob 的任务是「写 API 路由」——两人都顺手改写了 `app.txt`。

alice `write_file("app.txt", ...)`，bob 也 `write_file("app.txt", ...)`。同一份文件被两个人同时写，**互相覆盖**；事后也分不清哪行属于哪份活。

s15–s17 解决了「谁干什么」，但没解决「**在哪干**」。Codex 本机并行（桌面 App 的 Worktree、CLI 的 `-C` / 实验 `--worktree`）靠的就是：每个 session 一份 checkout。Cloud 的容器隔离是另一条线，留给 s23。

---

## 解决方案

![Worktree Isolation](images/worktree-isolation.svg)

给**每个 session 一个独立的 git worktree**——另一份工作目录，挂一条分支，共享同一个 `.git`。alice 在 `wt-t1/` 里改她的 `app.txt`，bob 在 `wt-t2/` 里改他的：**同一个路径，两份不同的内容，同时躺在磁盘上**，谁也不覆盖谁。

root 先建两个 worktree，再并行启动 alice 和 bob——对应「用户 / App 开两条 Worktree 对话」，不再走 s17 的认领。模型没有 `create_worktree` 工具：harness 先定 cwd，再开循环。

教学版多写了命名分支 + `merge --no-ff`：App 默认是 **detached HEAD**，Codex **不会**自动并进 `main`。merge 只是为了让「冲突被推迟到交回那一刻」看得见。

| 操作 | git 命令 | 作用 |
|------|----------|------|
| 创建 | `git worktree add <dir> -b wt/<id>` | 一个 session 一个目录 + 一条分支，共享同一个 `.git` |
| 隔离 | （无需命令） | 同一路径 `app.txt` 在两个目录各改各的，同时存在 |
| 合并（教学） | `git merge --no-ff wt/<id>` | 干净的并进 main；有真冲突时 git 拒绝 |
| 清理 | `git worktree remove` + `git branch -D` | 合并干净 → 删目录、删分支 |
| 保留 | `git merge --abort` | 冲突 → 回滚合并，留分支给人看（对照 App 的留目录 / Create branch / 开 PR） |

---

## 工作原理

四块：一个 git 帮手、创建 worktree、在各自目录里干活并提交、以及教学用的合并与清理。

**第 1 步**：把所有 git 调用收进一个同步帮手，在指定目录里跑、回传 stdout。

```ts
function git(cwd: string, args: string): string {
  return String(execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] })).trim();
}
```

**第 2 步**：`git worktree add <dir> -b <branch>` 一条命令同时建好新目录和新分支（基于当前 HEAD）。教学版用命名分支 `wt/t1`，好让后面能 merge；App 默认 detached HEAD，不污染你的分支列表。

```ts
function createWorktree(repo: string, dir: string, branch: string): void {
  git(repo, `worktree add "${dir}" -b "${branch}"`); // 新目录 + 命名分支，出自 HEAD
}
```

**第 3 步**：工人已经被派进自己的 worktree。`write_file` 只会写进 `job.dir`，够不到别人的目录。干完就地在该分支上提交。

```ts
async function worker(name: string, job: Job): Promise<void> {
  say(name, `session → ${path.basename(job.dir)}/  (branch ${job.branch})`);
  // …在 job.dir 里跑 agent 循环：write_file 只写进自己的 worktree…
  git(job.dir, "add -A");
  git(job.dir, `commit -m "${job.id}: ${job.title}"`);
}
```

root 先开目录，再并行两个 session——不是工人来抢：

```ts
for (const job of jobs) createWorktree(repo, job.dir, job.branch);
say("root", "opened wt-t1 (wt/t1) and wt-t2 (wt/t2) — not claiming, not Cloud");
await Promise.all([worker("alice", jobs[0]!), worker("bob", jobs[1]!)]);
```

**第 4 步**：教学合并。`mergeBack` 用 `--no-ff` 把分支并回 main——干净返回 `true`，撞上真冲突时 git 以非零码退出；`removeWorktree` 则删目录、删分支。这不是 Codex 的产品出口。

```ts
function mergeBack(repo: string, branch: string): boolean {
  try { git(repo, `merge --no-ff "${branch}" -m "merge ${branch}"`); return true; }
  catch { return false; } // 非零退出 = git 撞上真冲突
}
```

组装成 demo 末尾的合并循环：

```ts
for (const job of jobs) {
  if (mergeBack(repo, job.branch)) {
    removeWorktree(repo, job.dir, job.branch);  // 干净 → 删目录删分支
  } else {
    git(repo, "merge --abort");                 // 冲突 → 留分支给人看
  }
}
```

核心洞察：**worktree 给你的是「同一个仓库里的另一份目录」，不是「另一份仓库」。** 所有 worktree 共享一个 `.git`，但各自有独立的工作区——所以两个人改同一个路径互不干扰，因为根本不在同一个目录里。真正的冲突并不会消失，而是被**推迟到交回那一刻**才由 git 诚实地暴露出来。教学版用 merge 把这一刻演给你看；Codex App 的出口是留目录、Create branch、Handoff、开 PR，不是自动并进 `main`。

---

## 试一下

> **教学 demo 提示**：代码会在系统临时目录（`os.tmpdir()`）下用 `git init` 建一个**真正的 git 仓库**，再 `worktree add`、`commit`、`merge`，全部发生在该临时目录里，不碰你的项目。

**无需 API key 也能跑**：本章是**自运行演示**，没有 REPL。没有 `OPENAI_API_KEY` 时用内置的离线脚本化模型——root 先开两个 worktree，alice 和 bob 在各自目录里改写同一个 `app.txt`，然后演示一次干净合并 + 一次真冲突，全程打印旁白。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s18_worktree_isolation/code.ts                # 离线 demo 模型
OPENAI_API_KEY=sk-... npx tsx s18_worktree_isolation/code.ts   # 真实模型
```

试试这些改动：

1. 让两份任务改**不同**的文件（比如 bob 改成写 `routes.txt`），看两次 merge 都干净、两个 worktree 都被清理。
2. 用真实 key 跑一遍，看模型给 `app.txt` 写出的不同内容。
3. 跑完后执行 `git -C <打印出的 repo 路径> log --oneline --graph`，看分支与合并的拓扑。

观察重点：两个 worktree 里的 `app.txt` 是不是「同路径、不同内容」同时存在？第一次 merge 为何干净、第二次为何冲突？冲突的分支是被删掉了，还是留下来给人看？

---

## 接下来

现在并行 session 各有各的目录了。但他们的能力，始终受限于我们亲手写进 harness 的那几个工具——`write_file`、`shell`……

如果工具不在我们手里呢？比如公司内部的 Jira、一套自建的部署系统、一个知识库——总不能为每一个都重写进 harness。

s19 MCP Servers → 给 agent 装一座「外部工具桥」：任何实现了标准协议的服务都能即插即用，agent 根本不用知道它是谁写的。

<details>
<summary>深入 Codex 源码</summary>

> 以下对照官方文档 [Worktrees](https://developers.openai.com/codex/app/worktrees)、CLI 的 `-C` / 实验 `--worktree`，以及 s23 已经写明的 Codex Cloud。对照方式与 s12 相同：源码和产品有本机 git worktree；**没有**模型认领工具，也**不是** Cloud 容器。

**教学版的 worktree = 本机并行 session 的目录隔离 + 教程多写的命名分支与 merge。**

<details>
<summary>一、Codex 有本机 worktree，没有认领 API</summary>

说清楚「有 / 没有」：

- **Codex 有**：桌面 App 的 Worktree 对话（默认目录 `$CODEX_HOME/worktrees`，默认 **detached HEAD**）、Handoff（Local ↔ Worktree）、定时任务可跑在后台 worktree、`.worktreeinclude` 复制被 ignore 的本地文件。CLI 稳妥的做法是 `git worktree add` 再 `codex -C <dir>`；0.154+ 有实验 `--worktree` / `/worktree`（先 `codex features enable worktrees`）。
- **Codex 没有**：模型工具 `create_worktree` / `keep_worktree`、工人自领后再建目录、自动 `merge` 进 `main`、以及「这就是 Cloud 容器」。
- **本章额外实现**：root 建命名分支 `wt/t1`、`wt/t2`，两个工人并行 `write_file`，再用 `merge --no-ff` / `merge --abort` 把推迟的冲突演出来。

模型始终只看到自己的 cwd。Worktree 是 **session 启动时 harness 定的**，不是工具调用。

</details>

<details>
<summary>二、目录隔离不是 Cloud 环境隔离</summary>

教学版用 `git worktree` 做**目录级**隔离：几个工作区共享一个 `.git`、一台机器、一个文件系统。这已经足够解决「同一路径互相覆盖」。

Codex Cloud（s23）走得更远——每个任务跑在**它自己的隔离执行环境**（容器 / 微型虚拟机）里，文件系统、进程、网络都分开，产物是 diff / PR，遥控器是 `codex cloud` / `codex apply`。内部实现不在开源 `codex-rs` 里。**不要**把 `git worktree add` 说成 Cloud。

s04 的 `workspace-write` 锁的是**当前 cwd**。两个 worktree 再加 sandbox，写不进对方目录——那是 sandbox 的事，本章不叠一层。

</details>

<details>
<summary>三、教学 merge ≠ 产品出口</summary>

App 干完活之后，人可以：继续在 worktree 里验、Create branch here、Handoff 回 Local、开 PR。CLI 实验 worktree 也是留 checkout 给人处理。**都不会**自动并进 `main`。

教学版的「merge 成功 → 清理 / 冲突 → `merge --abort` 留分支」是为了让「冲突推迟到交回」看得见。语义可以对照「人来拍板」；不要说成 Codex 有一条自动 merge 流水线。

</details>

<details>
<summary>四、生命周期边角本章不做</summary>

App 默认只留最近大约 15 个托管 worktree，归档对话会删，删前打快照。Handoff 要处理「同一分支不能同时 checkout 在两处」。孤儿 worktree、`git worktree prune`、路径穿越校验、未提交时拒绝删除——真实实现要处理，教学版略掉。

认领竞赛是 s17，信箱是 s16，Cloud 容器是 s23，都不在本章叠一层。

</details>

**一句话**：Codex 用 git worktree 给本机并行 session 一块 disjoint 的地盘；本章多写的是「同路径两份内容，冲突推迟到 merge 才诚实暴露」。Cloud 容器归 s23。

</details>

<!-- translation-sync: zh@v2, en@v2 -->
