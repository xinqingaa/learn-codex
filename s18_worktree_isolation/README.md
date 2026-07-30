# s18: Worktree Isolation — 一个任务一个目录

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s17](../s17_autonomous_agents/) → [s18](../s18_worktree_isolation/) → [s19](../s19_mcp_servers/) → ... → s20
> *"One task, one directory"* — 并行的手各改各的目录，互不打架。
>
> **Harness 层**：协作 —— 用 git worktree 给并行执行做目录隔离（Codex Cloud 模型）。

---

## 问题

s17 让空闲的工人自己认领任务了，但他们还挤在**同一个工作目录**里。alice 的任务是「设计数据库 schema」，bob 的任务是「写 API 路由」——两人都顺手改写了 `app.txt`。

alice `write_file("app.txt", ...)`，bob 也 `write_file("app.txt", ...)`。同一份文件被两个人同时写，**互相覆盖**；而且事后根本分不清哪行改动属于哪份任务，想单独回滚某一份都做不到。

s15–s17 解决了「谁干什么」（任务系统）和「怎么协调」（消息契约、自认领），但没解决「**在哪干**」。本章要把这个问题补上。

---

## 解决方案

![Worktree Isolation](images/worktree-isolation.svg)

给**每份任务一个独立的 git worktree**——一个独立的工作目录，挂一条独立分支，但共享同一个 `.git`。alice 在 `wt-t1/` 里改她的 `app.txt`，bob 在 `wt-t2/` 里改他的 `app.txt`：**同一个路径，两份不同的内容，同时躺在磁盘上**，谁也不覆盖谁。

这正是 **Codex Cloud 的模型**：一个任务跑在一个隔离的环境里，最后把改动作为 diff / PR 交回。本章用本地 worktree 把这套「隔离 → 干活 → 合并 → 清理」的生命周期跑给你看。

| 操作 | git 命令 | 作用 |
|------|----------|------|
| 创建 | `git worktree add <dir> -b wt/<task>` | 一个任务一个目录 + 一条分支，共享同一个 `.git` |
| 隔离 | （无需命令） | 同一路径 `app.txt` 在两个目录各改各的，同时存在 |
| 合并 | `git merge --no-ff wt/<task>` | 干净的自动并进 main；有真冲突时 git 拒绝 |
| 清理 | `git worktree remove` + `git branch -D` | 合并干净 → 删目录、删分支 |
| 保留 | `git merge --abort` | 冲突 → 回滚合并，留分支给人 review（Codex Cloud 的「开 PR」时刻） |

---

## 工作原理

四块：一个 git 帮手函数、创建 worktree、在各自 worktree 里干活并提交、以及最后的合并与清理。

**第 1 步**：把所有 git 调用收进一个同步帮手，在指定仓库里跑、回传 stdout。

```ts
function git(repo: string, args: string): string {
  return String(execSync(`git ${args}`, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })).trim();
}
```

**第 2 步**：创建 worktree——`git worktree add <dir> -b <branch>` 一条命令同时建好新目录和新分支（基于当前 HEAD）。一个任务绑定一个目录、一条分支。

```ts
function createWorktree(repo: string, root: string, task: Task): { dir: string; branch: string } {
  const dir = path.join(root, task.worktree);
  const branch = `wt/${task.id}`;
  git(repo, `worktree add "${dir}" -b ${branch}`);   // 新目录 + 新分支，出自 HEAD
  return { dir, branch };
}
```

**第 3 步**：工人认领任务后，在**自己的 worktree 里**跑 agent 循环——`write_file` 只会写进 `wt.dir`，够不到别人的目录。干完就地在该分支上提交。

```ts
async function worker(name: string, board: TaskBoard, repo: string, root: string): Promise<void> {
  const task = board.claimNext(name);
  if (!task) return;
  const wt = createWorktree(repo, root, task);        // 一个任务一个目录 + 分支
  // …在 wt.dir 里跑 agent 循环：write_file 只写进自己的 worktree…
  git(wt.dir, "add -A");
  git(wt.dir, `commit -m "${task.id}: ${task.title}"`);
  board.complete(task.id);
}
```

**第 4 步**：合并与清理。`mergeBack` 用 `--no-ff` 把分支并回 main——干净返回 `true`，撞上真冲突时 git 以非零码退出、返回 `false`；`removeWorktree` 则删目录、删分支。

```ts
function mergeBack(repo: string, branch: string): boolean {
  try { git(repo, `merge --no-ff ${branch} -m "merge ${branch}"`); return true; }
  catch { return false; }                            // 非零退出 = git 撞上真冲突
}
function removeWorktree(repo: string, dir: string, branch: string): void {
  git(repo, `worktree remove --force "${dir}"`);
  git(repo, `branch -D ${branch}`);
}
```

组装成 demo 末尾的合并循环：

```ts
for (const t of board.all()) {
  const branch = `wt/${t.id}`;
  if (mergeBack(repo, branch)) {
    removeWorktree(repo, path.join(root, t.worktree), branch);  // 干净 → 删目录删分支
  } else {
    git(repo, "merge --abort");                                 // 冲突 → 留分支给人 review
  }
}
```

核心洞察：**worktree 给你的是「同一个仓库里的另一份目录」，不是「另一份仓库」。** 所有 worktree 共享一个 `.git`（对象库、引用都在一处），但各自有独立的工作区和当前分支——所以两个人改同一个路径互不干扰，因为根本不在同一个目录里。真正的冲突并不会消失，而是被**推迟到合并那一刻**才由 git 诚实地暴露出来：干净就自动并进 main，冲突就 `merge --abort`、留分支给人决断。这个「merge 时才见真章」的时刻，正是 Codex Cloud 把一份改动变成 PR 交回给人的时刻。

---

## 试一下

> **教学 demo 提示**：代码会在系统临时目录（`os.tmpdir()`）下用 `git init` 建一个**真正的 git 仓库**，再 `worktree add`、`commit`、`merge`，全部发生在该临时目录里，不碰你的项目。

**无需 API key 也能跑**：本章是**自运行演示**，没有 REPL。没有 `OPENAI_API_KEY` 时用内置的离线脚本化模型——alice、bob 各认领一份任务、在各自的 worktree 里改写同一个 `app.txt`，然后演示一次干净合并 + 一次真冲突，全程打印旁白。

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

1. 让两份任务改**不同**的文件（比如 t2 改成写 `routes.txt`），看两次 merge 都干净、两个 worktree 都被清理。
2. 用真实 key 跑一遍，看模型给 `app.txt` 写出的不同内容。
3. 跑完后执行 `git -C <打印出的 repo 路径> log --oneline --graph`，看分支与合并的拓扑。

观察重点：两个 worktree 里的 `app.txt` 是不是「同路径、不同内容」同时存在？第一次 merge 为何干净、第二次为何冲突？冲突的分支是被删掉了，还是留下来等人 review？

---

## 接下来

现在 agent 团队能在隔离的目录里自组织了。但他们的能力，始终受限于我们亲手写进 harness 的那几个工具——`write_file`、`shell`、任务板……

如果工具不在我们手里呢？比如公司内部的 Jira、一套自建的部署系统、一个知识库——总不能为每一个都重写进 harness。

s19 MCP Servers → 给 agent 装一座「外部工具桥」：任何实现了标准协议的服务都能即插即用，agent 根本不用知道它是谁写的。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 git worktree 的通行用法，并对照 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`）与 Codex Cloud 的整体思路。教学版的「一任务一 worktree」是隔离模型的最小骨架；真实实现的隔离更强、恢复更全。

**教学版的 worktree ≈ Codex Cloud 里一个任务的隔离环境。** 差异在隔离的**强度**和生命周期的**完备性**。

<details>
<summary>一、目录隔离 vs 环境隔离</summary>

教学版用 `git worktree` 做**目录级**隔离：几个工作区共享一个 `.git`、一台机器、一个文件系统。这已经足够解决「同一路径互相覆盖」的问题。Codex Cloud 走得更远——每个任务跑在**它自己的隔离执行环境**（容器 / 微型虚拟机）里，连文件系统、进程空间、网络都是分开的，再把仓库克隆进去。教学版选 worktree 是因为它足够轻、本地就能跑，又恰好演示了同一件事：**给并行的改动一块 disjoint 的地盘**。

</details>

<details>
<summary>二、合并冲突 = Codex Cloud 的「开 PR」时刻</summary>

教学版在本地 `git merge`：干净就自动并入 main，冲突就 `merge --abort`、留分支给人。Codex Cloud 把这一步产品化——任务在隔离环境里干完后，改动被收成一个 **diff / PR** 交回给人审阅，冲突或不确定的地方由人拍板，而不是自动合并。教学版的「merge 成功 → 清理 / 冲突 → 留分支」正是这套「自动归并或上交人审」的最小复刻。

</details>

<details>
<summary>三、生命周期的清理与恢复</summary>

教学版演示了生命周期的主干：`worktree add`（创建）→ 干活 → `merge`（合并）→ `worktree remove` + `branch -D`（清理），以及 `merge --abort` + 保留分支（上交）。真实实现还要处理教学版略掉的边角：worker 中途崩溃后**孤儿 worktree 怎么回收**；用 `git worktree list` / `git worktree prune` 对账、清掉残留；worktree 名做校验以挡路径穿越；未提交改动时默认拒绝删除。这些都是叠加在「创建 → 隔离 → 合并 → 清理」主干上的加固，不改变主干本身。

</details>

<details>
<summary>四、为什么这对你本地的并行 session 也有用</summary>

worktree 不只是云端的概念。本机同时跑多个 agent session（或一边自己改、一边让 agent 改）时，给每个 session 一个 worktree，就能让它俩在同一份仓库里各改各的、互不踩——这正是 `codex` 在本地处理并行工作的通行做法。教学版用两个 `async` worker 模拟的「并行互不干扰」，放到你本机的两个终端里同样成立。

</details>

**一句话**：并行安全的本质不是「让改动不冲突」，而是「给每份改动一块 disjoint 的地盘，把冲突推迟到合并那一刻由 git 诚实暴露」。教学版用 `git worktree add / merge / remove` 就把这条主干跑通了；Codex Cloud 只是把同样的模型搬到了更强的隔离环境、并把「合并」换成了「开 PR 交人审」。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
