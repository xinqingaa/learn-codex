# s09: Memory & Sessions — 把会话写进磁盘，它就有一整个生命周期

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s08](../s08_context_compact/) → `s09` → [s10](../s10_instructions/) → `s11` → ... → s20
> *"Write every turn to disk, and a session never really ends"* — 每一轮都落盘，会话就比进程长寿：能续、能分叉、能归档、能删。
>
> **Harness 层**：记忆 —— 跨进程、跨会话的持久状态。

---

## 问题

从 s01 到 s08，`thread` 都只活在内存里。进程一关、终端一退，整个会话就没了。

这带来两个真实的麻烦。其一：你让 Agent 干一个要跑很久的活，中途想关掉、明天接着干——做不到，记忆随进程一起消失。其二：它干到一半，你想回顾「它之前到底做了什么、改了哪些文件」——没有任何记录可查。

而一旦会话**能**存下来，新的麻烦立刻出现：会话会越攒越多。你想**接着**上次那条干（resume）；想从某个中间状态**岔出一条分支**试试另一个思路，又不破坏原会话（fork）；攒了几十条之后，想把不常用的**收起来**不碍事、想回头再**翻出来**（archive / unarchive），把彻底没用的**删掉**（delete）。

模型本身没有持久状态，所有「记忆」都在上下文里；上下文在内存里；内存随进程消失。问题不在模型记性差，而在 **harness 从没把会话写到过一个比进程更长寿、并能在其上管理的地方**。

---

## 解决方案

![Rollout Persistence & Resume](images/memory-sessions.svg)

把会话写成一个**只追加（append-only）的 JSONL 日志**：每产生一个新 item（user 消息、工具调用、工具输出、最终回复），就立刻把它序列化成一行，追加到 `rollout-<id>.jsonl`。进程可以随时死掉，磁盘上的日志还在——于是一整套**会话生命周期**都建立在这份日志上。

| 概念 | 作用 | 教学版实现 |
|------|------|-----------|
| `rollout-<id>.jsonl` | 一个会话的只追加日志 | 每个 item 一行 JSON |
| `session_meta` | 日志头 | 首行记录 id / cwd / 启动时间（fork 时还有 `forked_from`） |
| write-through | 何时写盘 | item 一产生就追加，不等 turn 结束 |
| session store | 会话存哪 | `~/.codex/sessions/` 下每个会话一个文件 |

围绕这份日志，Codex 给了一组**生命周期子命令**（真实 CLI，v0.144.6 已验证）：

| 命令 | 干什么 | 关键 flag |
|------|--------|-----------|
| `codex resume [SESSION_ID] [PROMPT]` | 重建线程并**继续**（默认弹选择器） | `--last` 续最近一条 · `--all` 不看 cwd 全列出 · `--include-non-interactive` |
| `codex fork [SESSION_ID] [PROMPT]` | 把一条会话**复制成新副本**接着走 | `--last` 岔最近一条 · `--all` |
| `codex archive <SESSION>` | 把会话**收起来**，从默认选择器里隐藏 | `SESSION` 是 UUID 或会话名 |
| `codex unarchive <SESSION>` | 把归档的会话**翻回来** | 同上 |
| `codex delete <SESSION>` | **永久删除**一条会话 | `--force` 不询问（须用 UUID） |

`resume` 和 `fork` 的 `SESSION_ID` 省略时默认弹出选择器（按当前 cwd 过滤，`--all` 取消过滤并显示 CWD 列）；`archive` / `unarchive` / `delete` 则必须点名一条会话。

两个关键设计：一是 **write-through**——item 一产生就落盘，进程在任意时刻崩溃，磁盘记录都完整到最后一刻；二是 **fork 是复制不是移动**——岔出的副本拿到一个全新的 id 和日志头（记下 `forked_from`），原会话原封不动，于是同一条历史可以长出多条互不影响的分支。

---

## 工作原理

把这个生命周期翻译成 TypeScript，分步来看：

**第 1 步**：会话存成一个目录，每个会话一个 `rollout-<id>.jsonl`；归档就是挪进 `archived/` 子目录。

```ts
const SESSIONS_DIR = process.env.CODEX_SESSIONS ?? join(tmpdir(), "learn-codex-s09", "sessions");
const ARCHIVE_DIR = join(SESSIONS_DIR, "archived");
const rolloutPath = (id: string) => join(SESSIONS_DIR, `rollout-${id}.jsonl`);
const archivedPath = (id: string) => join(ARCHIVE_DIR, `rollout-${id}.jsonl`);
```

**第 2 步**：开新会话写日志头（`session_meta`），item 一产生就 write-through 追加成一行。

```ts
function startRollout(id: string, forkedFrom?: string): string {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const meta = { type: "session_meta", id, cwd: CWD,
    started: new Date().toISOString(), ...(forkedFrom ? { forked_from: forkedFrom } : {}) };
  writeFileSync(rolloutPath(id), JSON.stringify(meta) + "\n"); // 截断：全新会话
  return rolloutPath(id);
}
function appendRollout(path: string, items: unknown[]): void {
  if (items.length === 0) return;
  appendFileSync(path, items.map((i) => JSON.stringify(i)).join("\n") + "\n"); // write-through
}
```

**第 3 步**：resume——读回每一行、跳过 `session_meta`，replay 成 thread，从上次停下的地方继续。

```ts
function loadRollout(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((r) => r.type !== "session_meta"); // 重建出精确的历史线程
}
```

**第 4 步**：fork——读全量历史，写一个**新 id** 的文件：新日志头记下 `forked_from`，原会话不动。

```ts
function forkSession(srcId: string): string {
  const history = loadRollout(rolloutPath(srcId)); // 全部 item（meta 已跳过）
  const id = newId();
  startRollout(id, srcId);                  // 新头：记下父会话
  appendRollout(rolloutPath(id), history);  // 再复制整段历史
  return id;
}
```

**第 5 步**：archive / unarchive / delete——就是对这个目录的移动与删除。

```ts
function archiveSession(id: string)   { mkdirSync(ARCHIVE_DIR, { recursive: true });
  if (existsSync(rolloutPath(id))) renameSync(rolloutPath(id), archivedPath(id)); } // 藏起来
function unarchiveSession(id: string) { if (existsSync(archivedPath(id))) renameSync(archivedPath(id), rolloutPath(id)); }
function deleteSession(id: string)    { rmSync(rolloutPath(id), { force: true }); rmSync(archivedPath(id), { force: true }); }
```

**第 6 步**：选择器列出「可见」会话——读每个文件的 `session_meta`，归档的不列。

```ts
function listSessions(includeArchived = false): SessionMeta[] {
  const dirs = includeArchived ? [SESSIONS_DIR, ARCHIVE_DIR] : [SESSIONS_DIR];
  // …读每个 rollout-*.jsonl 的首行 session_meta，按 started 排序
}
```

**核心洞察**：整个生命周期都没有改变 agent 的形状——循环还是那个循环，工具还是那些工具。它只是把「thread 这个内存数组」镜像成「磁盘上一个只追加的日志」，再在这份日志上定义五个操作：**resume = 重放后继续；fork = 复制成新 id；archive / unarchive = 挪进 / 挪出隐藏目录；delete = 删文件**。因为每一项都在产生的瞬间落盘，进程死掉不丢数据；因为 fork 是复制，分支互不影响；因为归档只是移动，什么也不丢。离线 demo 会把这五个操作挨个走一遍，并实时打印选择器里「可见 / 归档」的变化。

---

## 试一下

> **教学 demo 提示**：本章会**真的写文件**——在 session store（默认系统临时目录，可用 `CODEX_SESSIONS` 改）里创建、复制、移动、删除多个 `rollout-*.jsonl`，也会执行模型生成的 `echo` 命令。

**无需 API key 也能跑**：没有 `OPENAI_API_KEY` 时，本章是**自运行的旁白演示**，自动把「新会话 → resume → fork → 列出 → archive → unarchive → delete」整条生命周期走一遍，无需任何输入。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s09_memory_sessions/code.ts                 # 旁白式生命周期演示
npx tsx s09_memory_sessions/code.ts --resume        # 真正续上最近一条会话
CODEX_SESSIONS=./.codex/sessions npx tsx s09_memory_sessions/code.ts  # 存到项目本地
```

试试这些实验：

1. 直接跑，看第 3 步 `[fork] A → B`：B 拿到新 id，但历史与 A 完全相同（`forked_from` 记在新日志头里）。
2. 看第 5–6 步：archive 之后选择器里 A 消失、归档计数 +1；unarchive 之后又回来——**什么都没删**。
3. 紧接着跑 `npx tsx s09_memory_sessions/code.ts --resume`，看它从磁盘 replay 出最近一条会话再继续。

观察重点：第 4 步选择器列出 2 条会话（原会话 + fork 副本）；第 7 步 delete 之后只剩 1 条。这五个操作**没有一个碰过 agent loop**——它们全是「磁盘上那份日志」的增删移查。

---

## 接下来

记忆能跨会话续上、能分叉、能归档了。但 system prompt 还是 s01 那行硬编码的字符串：换个项目要重写，加个能力要手改，而且每轮请求都带上全量内容。它应该像配置一样，在运行时按层组装。

s10 Instructions → 内置 base + 项目 `AGENTS.md` + `config.toml` 偏好，运行时拼出 system prompt、模型和推理档位。

<details>
<summary>深入 Codex 源码</summary>

> 以下内容基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构，以及本地 `codex` CLI（v0.144.6）各子命令 `--help` 的真实输出。教学版的「write-through 日志 + 一组对目录的增删移查」就是 Codex 会话持久化（rollout）与生命周期子命令的最小骨架；差异全在记录粒度与恢复入口的工程细节上。

**教学版的 `loadRollout` / `forkSession` / `archiveSession` / `deleteSession` ≈ 真实 Codex 的 `codex resume|fork|archive|unarchive|delete`。** 下面每一项都是在这个核心上的展开。

<details>
<summary>一、真实路径：~/.codex/sessions 下的 rollout 文件</summary>

教学版把日志写到系统临时目录。Codex 把每个会话的 rollout 持久化到 `$CODEX_HOME`（默认 `~/.codex`）下的 `sessions/` 目录，按日期分层，文件名大致是 `rollout-<时间戳>-<id>.jsonl`。一台机器上可以并存很多历史会话，`codex resume` / `codex fork` 才能列出它们让你挑。教学版用平铺的一层目录，是为了让「追加 → 重放 → 复制 → 移动」这条链路一眼可见。

</details>

<details>
<summary>二、resume / fork 的选择器与过滤</summary>

真实 `codex resume` 与 `codex fork` 在省略 `SESSION_ID` 时弹出一个**交互选择器**，默认按当前工作目录（cwd）过滤；`--all` 取消过滤并多显示一列 CWD；`--last` 直接选最近一条跳过选择器；`codex resume` 还多一个 `--include-non-interactive`，把 `codex exec` 这类非交互会话也列进来。两者都可带一个可选 `[PROMPT]` 作为续上 / 岔出后的第一句话。教学版用 `--resume` 选「最近一条」模拟了 `--last`。

</details>

<details>
<summary>三、fork 是「复制成新会话」</summary>

`codex fork` 把一条已存会话**复制成一条新会话**——历史照搬，但拿到一个全新的会话 id，从此与原会话各自独立演化。这对应教学版 `forkSession`：读全量历史 → 写新 id 的日志头（教学版额外记了 `forked_from`）→ 复制全部 item。适合「从某个中间状态岔出去试另一个思路，又不破坏原会话」。

</details>

<details>
<summary>四、archive / unarchive / delete：存量管理</summary>

会话攒多了就要管。`codex archive <SESSION>` 把一条会话**收起来**——从默认选择器里隐藏但**不删除**；`codex unarchive <SESSION>` 再把它翻回来；`codex delete <SESSION>` 才是**永久删除**（`--force` 跳过确认、且要求 `SESSION` 是 UUID）。这三个子命令的 `SESSION` 都可以是 UUID 或会话名（能解析成 UUID 时按 UUID 处理）。教学版用「挪进 / 挪出 `archived/` 子目录」模拟归档的「隐藏但不删」，用 `rmSync` 模拟删除。

</details>

<details>
<summary>五、为什么是 append-only JSONL</summary>

教学版和 Codex 都选了「只追加 + 每行一条 JSON」这种格式，原因很实在：崩溃安全（已写入的行不会因中途退出而损坏）、写入便宜（追加一行是 O(1)）、对人类友好（可以直接 `cat` / `tail` 审计每一步），而且天然适合做「复制出一条分支、整段重放、交给别的工具分析」的会话存档。开头那行 `session_meta`（id、cwd、模型与配置等）让 resume 能**精确**重建线程，而不是重新理解一段文字。

</details>

**一句话**：Codex 的会话持久化核心就是教学版这套「每个 item 追加一行 → 重放即恢复」。`resume` / `fork` / `archive` / `unarchive` / `delete` 这五个生命周期子命令，本质都是对磁盘上那份只追加日志的「增、删、移、查、复制」——没有一个需要改动 agent loop。先吃透「write-through + replay = 可恢复的会话」，再把「生命周期 = 日志文件上的文件操作」这一条看透，其余都是工程加固。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
