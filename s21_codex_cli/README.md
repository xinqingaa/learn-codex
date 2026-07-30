# s21: Codex CLI 全景 —— 一个二进制，许多扇门

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s20](../s20_full_harness/) → `s21` → [s22](../s22_config_toml/) → `s23`
> *"One binary, many doors"* —— 子命令与斜杠命令，本质都是「通往同一个 harness 的不同入口」。
>
> **Harness 层**：Codex 深挖 —— 换的不是 loop，而是「你是从哪扇门进来的」。

---

## 问题

Part I（s01–s20）我们一直在造**一个** loop。但真实的 Codex 不是一堆散落的脚本，而是把这个 loop 装在**一个 `codex` 二进制**后面，给你许多扇门：

- 想交互式地用？直接敲 `codex`，进 TUI。
- 想让脚本调用、跑完就退出？`codex exec "..."`。
- 想接着上次没干完的活？`codex resume --last`。
- 想让它审查代码？`codex review`。
- 想管登录、管 MCP 服务器？`codex login`、`codex mcp`。

会话进行到中途，你还想随时调参数：`/model` 换个模型、`/approvals` 改审批策略、`/compact` 压一压上下文、`/status` 看看用量。

这些入口形态各异，但它们**不该各自重造一个 agent**。问题是：怎么设计一层「分发」，让这么多入口都收敛到 s01 那一个 loop 上？

---

## 解决方案

![The Codex CLI Surface](images/cli.svg)

加**一层分发（dispatch）**：解析 argv 子命令和 `/` 开头的斜杠命令，把每一个都路由到某个 harness 函数。loop 本身一行不改——分发只决定「你从哪扇门进来」。

**argv 子命令**（进门时选一次）：

| 命令 | 形态 | 干什么 |
|------|------|--------|
| `codex` | TUI（默认） | 交互式会话，所有斜杠命令可用 |
| `codex exec "..."` | 无头 | 非交互地跑一个任务，打印结果就退出（s23 细讲） |
| `codex resume [--last]` | 无头/TUI | 重载一个保存的会话并继续（s09 的 rollout） |
| `codex review [--base B]` | 无头 | 走同一条 loop 做代码审查（s23 细讲） |
| `codex login [--device-auth]` / `logout` | 一次性 | ChatGPT 浏览器登录 / `--with-api-key` / 无头设备码 |
| `codex mcp list\|add\|...` | 一次性 | 管理 MCP 服务器（s19） |

**会话内斜杠命令**（随时调）：都进一张**分发表**，每个 handler 改动共享的 `Session` 或 harness 并打印结果。

| 命令 | 作用 |
|------|------|
| `/model <m> <effort>` | 切换模型与推理档位 |
| `/approvals <policy>` | 设置 `approval_policy`（新版叫 `/permissions`，旧名仍路由到这） |
| `/compact` | 压缩会话，腾出上下文 |
| `/status` | 当前配置 + token 用量 |
| `/diff` | 看工作区 git diff |
| `/init` | 往工作区写一份 `AGENTS.md` 脚手架 |
| `/new` · `/mcp` · `/help` · `/quit` | 新会话 · 列 MCP · 帮助 · 退出 |

关键设计：**斜杠命令和 prompt 共用同一个入口**——一行输入，以 `/` 开头就进分发表，否则当 prompt 喂给 loop。

---

## 工作原理

把这层分发翻译成 TypeScript，分步来看：

**第 1 步**：一个所有门共享的 `Session` 状态——模型、档位、审批、沙箱、工作目录、对话线程。

```ts
interface Session {
  model: string; effort: Effort; approval: Approval;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  workspace: string; thread: unknown[]; mcpServers: string[];
}
```

**第 2 步**：斜杠命令分发表。每个 handler 拿到 `Session` 和参数，改状态、打印结果。`/model` 就是改两个字段：

```ts
const SLASH: Record<string, { desc: string; run: Handler }> = {
  "/model": { desc: "choose the active model and reasoning effort",
    run: (s, [m, e]) => {
      if (m) s.model = m;
      if (e && ["low","medium","high"].includes(e)) s.effort = e as Effort;
      console.log(`model → ${s.model}   effort → ${s.effort}`);
    } },
  // …/approvals /compact /status /diff /init /new /mcp /help…
};
SLASH["/permissions"] = SLASH["/approvals"]; // 新名字，同一个 handler
```

**第 3 步**：一个会话内的分发入口。`/...` 进表，否则当 prompt 进 loop。

```ts
async function dispatch(s: Session, line: string): Promise<void> {
  if (line.startsWith("/")) {
    const [name, ...args] = line.split(/\s+/);
    const cmd = SLASH[name];
    return cmd ? cmd.run(s, args) : console.log(`unknown command ${name}`);
  }
  s.thread.push({ role: "user", content: line });
  return agentLoop(s);   // ← s01 那个 loop，一字未改
}
```

**第 4 步**：argv 子命令——进门时选门。每个子命令新建一个 `Session`，然后复用同一个 `dispatch` / `agentLoop`。

```ts
async function routeArgv(argv: string[]): Promise<boolean> {
  const [sub, ...rest] = argv;
  const s = newSession(makeWorkspace());
  switch (sub) {
    case "exec":   await dispatch(s, rest.join(" ")); return true;  // 无头跑一个任务
    case "review": await dispatch(s, "review the current changes…"); return true;
    case "resume": /* 重载 rollout，s09 */ return true;
    case "login":  /* ChatGPT / api-key / device-auth */ return true;
    case "mcp":    /* 管理 MCP，s19 */ return true;
    default:       return false; // 不认识的子命令 → 落到 TUI
  }
}
```

**核心洞察**：整章没有碰 `agentLoop` 一下。`/model` 只是改 `s.model` / `s.effort`，下一轮回合 `callModel` 自然用上；`exec` 只是「不走 REPL、跑一个 prompt 就退」；`review` 只是「预置一段审查 prompt」。**所有门后面都是同一个 harness**——分发层让「命令行表面」和「agent 内核」彻底解耦。离线 demo 里你能看到：先 `/model gpt-5-codex high`，下一条 agent 消息就自报「这一轮跑在 model=gpt-5-codex、effort=high 上」——证明分发真的改到了 harness 的行为。

---

## 试一下

> **教学 demo 提示**：本章会在系统临时目录造一个带改动的 git 仓库作为「工作区」，不碰你的项目。

**无需 API key 也能跑**：离线时脚本化模型驱动 loop；`main()` 会放一段**写好的会话脚本**，把每扇门都走一遍（`/status`、`/model`、`/approvals`、`/diff`、`/init`、一条真实 prompt、`/compact`、`/mcp`、`/quit`）。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s21_codex_cli/code.ts                     # 旁白式 TUI 会话演示
npx tsx s21_codex_cli/code.ts exec "fix the bug"  # 走 exec 子命令（无头跑一次）
npx tsx s21_codex_cli/code.ts login               # 走 login 子命令
npx tsx s21_codex_cli/code.ts review              # 走 review 子命令
OPENAI_API_KEY=sk-... npx tsx s21_codex_cli/code.ts exec "..."   # 真实模型
```

试试这些实验：

1. 直接跑，看会话脚本里 `/model gpt-5-codex high` 之后，那条 agent 消息是不是自报了新的 model/effort。
2. 跑 `exec "..."` 和 `review`，注意它们跟 TUI 用的是**同一个** `dispatch` 和 `agentLoop`。
3. 用真实 key 跑一次 `exec`，体会「无头模式」——没有 REPL，跑完就退出。

观察重点：`/status` 打印的 `thread` 长度和 token 估算，在 `/compact` 之后怎么变？斜杠命令和 prompt 是不是走的同一个入口函数？

---

## 接下来

命令行这扇门看明白了。但 `/model`、`/approvals` 这些「临时改一下」的设置，每次都敲太累——Codex 把它们固化成 `~/.codex/config.toml` 里的配置：模型、推理档位、审批、沙箱、自定义 provider、profiles、MCP 服务器……几十个旋钮，还有一套「谁覆盖谁」的优先级规则。

s22 config.toml 完全指南 → 把这些旋钮一个个解析清楚，并造一个「优先级解析器」：CLI flag > profile > config 文件 > 内置默认。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构，以及 `codex --help` / 各子命令 `--help` 的真实输出。教学版的「一张分发表 + 一个 argv 路由」就是 CLI 表面的最小骨架；真实实现是一个完整的多页 TUI。

**教学版的 `dispatch` + `routeArgv` ≈ 真实 Codex 的命令分发。** 下面每一项都是在这个核心上的展开。

<details>
<summary>一、子命令是 clap 定义的独立路径</summary>

教学版用一个 `switch` 路由子命令。真实 `codex-rs` 用 Rust 的 `clap` 定义命令树：`codex`（默认进 TUI）、`exec`、`review`、`resume`、`login`/`logout`、`mcp`、`cloud`、`apply`、`completion` 等，每个子命令有自己的 flag 集合。要点和教学版一致——这些子命令大多**不复用 TUI 的事件循环**，而是各自驱动同一套核心会话逻辑（`codex exec` 的非交互路径见 s23）。

</details>

<details>
<summary>二、斜杠命令是 TUI 里的弹出菜单</summary>

教学版把斜杠命令列在一张 map 里。真实 TUI 里，敲 `/` 会弹出一个可选菜单：`/model`、`/permissions`（旧称 `/approvals`）、`/compact`、`/status`、`/diff`、`/init`、`/new`、`/mcp`、`/review`、`/help`、`/quit` 等。每个命令同样只是「改动会话状态或触发一个 harness 动作」——`/model` 改模型与档位、`/compact` 触发一次压缩（s08）、`/init` 写 `AGENTS.md` 脚手架。教学版的「分发表 + 共享 Session」精确对应这种「命令只动状态、不动 loop」的设计。

</details>

<details>
<summary>三、自定义 prompts：`~/.codex/prompts/*.md`</summary>

真实 Codex 还支持**自定义斜杠命令**：把一段 prompt 模板写成 `~/.codex/prompts/review.md`，就能用 `/review` 调用它——本质是把「常用 prompt」也注册进分发表。教学版没有单独演示，但它就是「往 `SLASH` 表里再加一行」的事，只是 handler 把一个文件内容当 prompt 喂给 loop。

</details>

<details>
<summary>四、鉴权：ChatGPT 登录 vs API key vs 设备码</summary>

`codex login` 在真实实现里有三条路：默认「Sign in with ChatGPT」开浏览器走 OAuth（Plus/Pro/Business/Edu/Enterprise 计划可用）；`--with-api-key` 用 `OPENAI_API_KEY`；`--device-auth` 在无浏览器/无头环境走设备码流程。凭据落在 `~/.codex/` 下，`codex logout` 清除。教学版只打印了路由结果，因为鉴权本身不碰 loop——它只决定 `callModel` 时用什么凭证。

</details>

**一句话**：真实 Codex 的命令行表面——一堆子命令 + 一组斜杠命令 + 自定义 prompts——全部收敛到同一套会话内核上，靠的正是教学版这层「解析 → 路由 → 改状态/触发动作」的分发。理解了「门很多，loop 只有一个」，这套表面就看透了。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
