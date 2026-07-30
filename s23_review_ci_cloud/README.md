# s23: Review, CI & Cloud — harness 走出你的笔记本

[中文](README.md) · [English](README.en.md)

`s01` → ... → `s20` → [s21](../s21_codex_cli/) → [s22](../s22_config_toml/) → `s23`
> *"The harness leaves your laptop"* —— 同一个 agent loop，交给脚本、CI 和云去无人值守地跑。
>
> **Harness 层**:Codex 深潜 —— 换的不是 loop,而是「谁来驱动它、指向什么、结果怎么回来」。

---

## 问题

从 s01 到 s20，我们把一个 Codex 式 harness 一个机制一个机制地重建了出来;Part II 的 s21 看了真实 CLI 的命令面，s22 把 `config.toml` 的每个旋钮解析了一遍。但自始至终有一个前提没被打破:**loop 是由一个坐在键盘前的人驱动的**——你敲下 prompt，盯着它一轮一轮跑，该批的命令亲手批。

真实团队想要的恰恰相反，是「没人盯着它也得跑」：

1. **让它读代码，而不只是写代码**——把 agent 指向一个 diff，要它给出按优先级排序的审查意见，最好每个 PR 都自动来一遍，而不是我去聊天框里求它看。
2. **把它塞进脚本和 CI**——在 shell 脚本、GitHub Action 里跑一个任务，然后**程序化地**消费结果，而不是去读一段聊天记录。聊天文本对人是友好的，对脚本是灾难。
3. **让它替你离线跑**——把一个任务委派出去，它在一个隔离的云环境里自己跑，你合上电脑去开会，回来面对一个已经开好的 PR。

这三件事的共同点是：s01 那个 loop 本身一点问题都没有，问题是**怎么让同一个 loop 在无人值守的情况下、跑在真实的工作上、并把一个机器能用的结果交回来**。这不是 loop 的问题，是 loop 的「驱动方式」和「出口」的问题。

---

## 解决方案

![Review, CI & Cloud](images/review-ci-cloud.svg)

关键洞察一句话:`codex review`、CI 里的 `codex exec`、Codex Cloud 的任务，**是同一个 loop**，只换了三样东西——**谁驱动它**(人 / 脚本 / CI / 云)、**它指向什么**(一个 diff / 一个任务 / 一个被委派的任务)、**结果怎么回来**(行内评论 / JSONL 事件流 + 符合 schema 的 JSON / 一个 PR)。

| 形态 | 真实命令 | 谁驱动 | 指向什么 | 结果怎么回来 |
|------|----------|--------|----------|--------------|
| 审查模式 | `codex review [--uncommitted\|--base B\|--commit SHA]` | 人 / 脚本 | 一个 git diff | 按优先级排序的 findings(行内评论，不改工作区) |
| 无头执行 | `codex exec --json --output-schema s.json "task"` | 脚本 / CI | 一个任务 | stdout 的 JSONL 事件流 + 符合 schema 的最终消息 |
| 云任务 | `codex cloud exec \| status \| diff \| apply` | 云(托管) | 一个被委派的任务 | 隔离环境里跑出的 diff / PR |

**`codex review` 的审查范围**(真实 flag，顶层子命令，也以 `codex exec review` 的形式存在):

| flag | 审查对象 |
|------|----------|
| `--uncommitted` | 工作区里 staged + unstaged + untracked 的全部改动 |
| `--base <BRANCH>` | 当前分支相对 base 分支 merge-base 的 diff |
| `--commit <SHA>` | 某个 commit 引入的那一组改动 |
| `[PROMPT]` 或 `-` | 自定义审查指令;`-` 表示从 stdin 读 |
| `--title <TITLE>` | 在审查摘要里显示的提交标题 |

审查**只读**:它报告「按优先级排序、可执行的 findings」，以行内评论的形式挂在 diff 的具体行上，**不改动你的工作区**。

---

## 工作原理

把「无人值守的 review」翻译成 TypeScript。整条流水线是:造一个带 bug 的 diff → 用 review 系统提示 + `--output-schema` 跑 headless exec → 把运行过程以 JSONL 流到 stdout → 解析出结构化的 findings。

**第 1 步**：造审查目标。在临时目录里 `git init`、提交一个正确的 base，再写入一份**未提交**的改动——`git diff` 拿到的正是 `codex review --uncommitted` 会看到的那个 diff。这份改动里埋了三个从 diff 就能看出来的回归。

```ts
function buildSampleRepo(): string {
  const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s23-")), "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init -b main");
  // …config user.* …
  fs.writeFileSync(path.join(repo, "src", "login.ts"), BASE_TS);
  git(repo, "add -A");
  git(repo, 'commit -m "base login helpers"');
  fs.writeFileSync(path.join(repo, "src", "login.ts"), BUGGY_TS); // 未提交的改动
  return repo;
}
const diff = git(repo, "diff"); // 未提交 → 对应 `codex review --uncommitted`
```

**第 2 步**:review 系统提示 + `--output-schema`。提示词把 agent 约束成「只读的审查者」——可以开文件看上下文，但绝不改文件，最后只回一个 JSON。schema 则把「最终消息」钉死成一个脚本可依赖的形状(这正是 `codex exec --output-schema` 干的事)。

```ts
const REVIEW_INSTRUCTIONS =
  `You are Codex running in review mode. You are given a unified git diff. ` +
  `Find real, prioritized problems … Use the shell only to read context; NEVER edit files. ` +
  `When done, reply with ONLY a JSON object matching the provided schema.`;

const FINDINGS_SCHEMA = {
  type: "object", required: ["overall_correctness", "findings"],
  properties: {
    overall_correctness: { type: "string", enum: ["patch is correct", "patch is incorrect"] },
    findings: { type: "array", items: { type: "object",
      required: ["title", "body", "file", "line", "severity"],
      properties: { title: {…}, body: {…}, file: {…}, line: {…},
        severity: { type: "string", enum: ["low", "medium", "high"] } } } },
  },
};
```

**第 3 步**:`--json` 事件流。headless 模式把每一行 JSON 打到 **stdout**；人的旁白走 **stderr**，这样 stdout 可以直接 pipe 给文件或 `jq`。事件类型与真实 `codex exec --json` 一致。

```ts
function emitEvent(type: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ type, ...extra })); // stdout = 机器通道
}
```

真实 `codex exec --json` 的事件与 item 类型:

| event.type | 含义 |
|------------|------|
| `thread.started` | 会话开始，带 `thread_id` |
| `turn.started` | 一轮开始 |
| `item.started` / `item.completed` | 一个 item(工具调用 / 消息)开始 / 完成，带 `item` 对象 |
| `turn.completed` | 一轮结束，带 `usage`(input/output/reasoning tokens) |
| `turn.failed` / `error` | 失败 / 错误 |

item 的 `type` 取值:`command_execution` · `agent_message` · `reasoning` · `file_change` · `mcp_tool_call` · `web_search` · `plan_update`。

**第 4 步**:headless 执行器 `codexExec`——本章的核心。它跑一个任务到底、中间没有人的参与;`json:true` 就把每一轮的工具调用和最终消息流成 JSONL;最后返回那条最终 agent 消息(也就是结构化 payload)。

```ts
async function codexExec(prompt: string, opts: ExecOptions): Promise<string> {
  if (opts.json) emitEvent("thread.started", { thread_id: `thr_${Date.now().toString(36)}` });
  if (opts.json) emitEvent("turn.started");
  const input: unknown[] = [{ role: "user", content: prompt }];
  let finalText = "";
  for (let step = 0; step < 8; step++) {
    const output = await callModel(input, opts);            // 带着 schema 的 Responses 调用
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {                                // 模型收工:最终消息
      for (const item of output)
        if (item.type === "message")
          for (const c of item.content ?? [])
            if (c.type === "output_text" && c.text) finalText += c.text;
      if (opts.json) emitEvent("item.completed", { item: { id: `item_${++itemSeq}`, type: "agent_message", text: finalText } });
      break;
    }
    for (const call of calls) {                              // 工具调用 → command_execution item
      const { command } = JSON.parse(call.arguments ?? "{}") as { command: string };
      const result = runShell(opts.cwd, command);
      if (opts.json) emitEvent("item.completed", { item: { id, type: "command_execution", command, status: "completed", aggregated_output: result.slice(0, 400) } });
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
  if (opts.json) emitEvent("turn.completed", { usage: approxUsage(input) });
  return finalText;
}
```

注意 `codexExec` 的签名:`{ instructions, cwd, json, schema }`。它什么「review」都不懂——**review 只是「换一份系统提示 + 在 prompt 里塞一个 diff + 挂一个 schema」的 exec**。这正是本章的论点:

```ts
const finalMessage = await codexExec(promptWithDiff, {
  instructions: REVIEW_INSTRUCTIONS, cwd: repo, json: true, schema: FINDINGS_SCHEMA,
});
const review = parseFindings(finalMessage); // 校验并解析出 findings
```

线上跑真实模型时，schema 通过 Responses API 的 Structured Outputs 直接约束生成(`text.format = { type: "json_schema", … }`),而不是事后校验。

**`codex exec` 的无头 flag(真实)**:

| flag | 语义 |
|------|------|
| `--json` | 把运行过程以 JSONL 事件流打到 stdout |
| `--output-schema <FILE>` | 用一份 JSON Schema 约束最终消息(Structured Outputs) |
| `-o, --output-last-message <FILE>` | 把最终 agent 消息写进文件(同时仍打印) |
| `--color <always\|never\|auto>` | 输出是否着色(默认 auto) |
| `-C, --cd <DIR>` | 指定 agent 的工作根目录 |
| `-s, --sandbox <MODE>` | `read-only` / `workspace-write` / `danger-full-access` |
| `-m, --model` / `-p, --profile` / `-c key=value` | 覆盖模型 / 预设 / 任意配置项 |
| `--skip-git-repo-check` · `--ephemeral` | 允许在非 git 目录运行 · 不把 session 落盘 |

### 接进 CI:`openai/codex-action`

CI 里没有新东西——就是「在某个 runner 上跑 `codex exec`」。官方 Action `openai/codex-action@v1` 帮你装好 CLI、配一条通往 Responses API 的安全代理，并套上权限管控;它把 `codex exec` 包了一层:

| input | 作用 |
|-------|------|
| `openai-api-key`(必填) | Responses API 代理的 key，存成 GitHub secret |
| `prompt` / `prompt-file` | 内联 / 文件形式的任务 |
| `permission-profile` | 如 `":read-only"` / `":workspace"`，控制文件系统与网络 |
| `safety-strategy` | `drop-sudo`(默认)/ `unprivileged-user` / `read-only` / `unsafe` |
| `output-file` · `working-directory` · `model` · `effort` · `codex-args` | 输出落点、工作目录、模型、推理档位、追加 CLI 参数 |
| (输出)`final-message` | 最终 agent 消息——下一步可回贴成 PR 评论 |

一个「PR 一开就自动 review」的最小 workflow:`actions/checkout` 拉代码 → `openai/codex-action@v1` 带着 `openai-api-key` + 一段 review prompt 跑 → 用 `github-script` 把 `final-message` 输出贴成 PR 评论。

### 委派给云:Codex Cloud

Codex Cloud 把同一个 loop 搬进**隔离的云环境**:每个任务一个独立容器 / 微型虚拟机，克隆你的仓库，先跑你配置的 **setup 脚本**(装依赖、注入变量与密钥、按策略开网络)，agent 在里面自主干活，你实时看日志或丢到后台;干完交回一份 summary + diff,你可以要求返工，或**一键开 PR**。从 CLI 侧用 `codex cloud` 驱动它:

| 子命令 | 作用 |
|--------|------|
| `codex cloud exec` | 不开 TUI，直接提交一个新的云任务 |
| `codex cloud status` / `list` | 查某个 / 全部云任务的状态 |
| `codex cloud diff` | 看某个云任务产出的 unified diff |
| `codex cloud apply` | 把某个云任务的 diff 应用到本地工作区(另见 `codex apply <TASK_ID>`) |

**核心洞察**:loop 从 s01 起就没变过。review 模式 = exec + 一份 review 提示 + 一个 diff + 一个 schema;headless = 把「人」从驱动席上拿掉，把结果从「聊天文本」换成「stdout 上的机器可读事件流」;CI 与 Cloud = 把同一个 exec 搬到别人的 runner / 容器里去跑。变的从来不是 loop，而是**谁坐在驾驶座上、方向盘指向哪、终点交回什么**。

---

## 试一下

> **教学 demo 提示**:代码会在系统临时目录(`os.tmpdir()`)下 `git init` 一个**真正的 git 仓库**,提交 base、写入一份带 3 个 bug 的未提交改动，再对它跑 headless review。全部发生在临时目录，不碰你的项目。

**无需 API key 也能跑**:本章是**自运行演示**，没有 REPL。没有 `OPENAI_API_KEY` 时用内置的脚本化「审查者」——它先 `cat -n src/login.ts` 看行号，再把 findings 以符合 schema 的 JSON 返回;全程把 `codex exec --json` 风格的事件流打到 stdout，把人读的旁白打到 stderr。

**准备**(首次运行):

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**:

```sh
npx tsx s23_review_ci_cloud/code.ts                       # 离线 demo(机器流 + 人读摘要)
npx tsx s23_review_ci_cloud/code.ts > events.jsonl        # 只留 stdout 的 JSONL 事件流
npx tsx s23_review_ci_cloud/code.ts 2>/dev/null | jq .    # 用 jq 逐条看机器通道
OPENAI_API_KEY=sk-... npx tsx s23_review_ci_cloud/code.ts # 真实模型(schema 走 Structured Outputs)
```

试试这些实验:

1. 直接跑，分辨两条通道:stdout 上那 6 行 JSONL(`thread.started` → `turn.completed`)是机器通道,stderr 上带时间戳的旁白是人通道。重定向 `> events.jsonl` 后，文件里应该**只有**事件流。
2. 改 `BUGGY_TS`(比如把 `shouldLock` 修对、只留两个 bug),再跑，看离线审查者的 verdict 和 findings 数量怎么变。
3. 用真实 key 跑一遍:`--output-schema` 会走 Responses 的 Structured Outputs,模型被**约束**产出合法 JSON;对比它和离线「事后校验」的差别。

观察重点:最终那条 `agent_message` 的 `text` 就是整份 findings JSON;`codexExec` 本身完全不「懂」review——换一份 `instructions` 和 prompt，它就是任意任务的 headless 执行器。

---

## 接下来

到这里，Part I 的 loop 已经被你拆到底、Part II 的三个深潜也走完了:s21 看了真实 CLI 的命令面，s22 把 `config.toml` 的每个旋钮解析了一遍，本章则看到同一个 loop 如何无人值守地跑在 review、CI 和云上。**这套 harness 已经没有秘密了。**

接下来没有 s24——轮到你把 s01 到 s23 拼成**你自己的** agent:拿 s01 的 loop 做骨架，按 s02–s20 逐层加上你要的机制，再用 s21–s23 的真实表面(CLI 子命令、`config.toml`、exec/review/cloud)把它对准真实的工作。想回到起点重看那个 30 行的 loop，就去 [s01](../s01_agent_loop/)。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库(`codex-rs`,Rust 实现)的整体结构、官方文档，以及本地安装的 `codex` CLI(v0.144.x)的 `--help` 输出。教学版的「review 提示 + `--json` 事件流 + `--output-schema`」就是这套无人值守表面的最小骨架;差异在工程细节与托管部分的闭源实现。

**教学版的 `codexExec` ≈ 真实的 `codex exec`;教学版的 review ≈ `codex review` / `codex exec review`。** 下面每一项都是在这个核心上的展开。

<details>
<summary>一、exec 是 codex-rs 里一条独立的非交互路径</summary>

教学版用「同一个 loop 去掉 REPL」来讲 headless。真实 `codex-rs` 里,`codex exec` 是一条**专门的非交互执行路径**:它不复用 TUI 的事件循环，而是把一次任务跑到结束，默认把人类可读的进度打到 stderr、把结果打到 stdout——这正是教学版「stdout 机器通道 / stderr 人通道」分流的由来。`codex review` 与 `codex exec review` 共享这条非交互路径，只是预置了审查用的系统提示与 diff 收集逻辑(`--uncommitted` / `--base` / `--commit`)。

</details>

<details>
<summary>二、--json 的 JSONL 事件流对应真实的事件类型</summary>

教学版的 `emitEvent` 发出的 `thread.started` / `turn.started` / `item.started` / `item.completed` / `turn.completed` / `turn.failed` / `error`,以及 item 的 `command_execution` / `agent_message` / `reasoning` / `file_change` / `mcp_tool_call` / `web_search` / `plan_update`,都来自官方文档对 `codex exec --json` 输出的描述。教学版只用了其中一个子集(工具调用 + 最终消息),并用人读的旁白替代了真实实现里更细粒度的流式增量事件;`usage` 在离线模式下是估算值，真实 `turn.completed` 携带的是精确的 token 计数。

</details>

<details>
<summary>三、--output-schema 落到 Responses 的 Structured Outputs</summary>

教学版在线上路径把 schema 塞进 `text.format = { type: "json_schema", … }`,这与真实 `codex exec --output-schema <FILE>` 的做法一致:把用户给的 JSON Schema 作为最终消息的响应格式，让模型**被约束**产出合法 JSON，而不是事后校验再重试。教学版额外保留了一个 `parseFindings` 的事后校验，是为了在离线脚本化模型下也能演示「校验」这一步;真实实现里 schema 不合法时会让模型重出。`-o/--output-last-message` 则对应「只把最终消息落到一个文件」。

</details>

<details>
<summary>四、CI 的 openai/codex-action 是独立仓库，包住 CLI</summary>

`openai/codex-action` 不在 `openai/codex` 主仓库里，而是一个独立的 GitHub Action:它安装 Codex CLI、架一条到 Responses API 的代理，并用 `permission-profile` / `safety-strategy` 在 runner 上收紧权限(默认 `drop-sudo`)。它对外暴露的 `final-message` 输出，本质就是 `codex exec` 跑完后的最终 agent 消息——教学版里 `codexExec` 返回的那条 `finalText`。把它贴成 PR 评论，就是「自动 review 机器人」。

</details>

<details>
<summary>五、Codex Cloud 是托管产品,CLI 只是它的遥控器</summary>

Codex Cloud 的隔离环境(每任务一个容器 / 微虚拟机、setup 脚本、网络策略、产物转 PR)是 **OpenAI 托管的服务**，其内部实现并不在开源的 `codex-rs` 里。开源 CLI 提供的是 `codex cloud exec / status / list / diff / apply` 这组「遥控器」子命令，用来提交任务、查状态、取 diff、把 diff 应用回本地(配合 `codex apply <TASK_ID>`)。教学版用本地临时仓库 + `git diff` 模拟「改动 → diff → 交回」的闭环;真实的隔离强度(文件系统 / 进程 / 网络都分开)更接近 s18 讲的 worktree 模型被搬到了容器里。

</details>

**一句话**:review、CI、Cloud 都不是新的 agent，而是同一个 loop 的三种「无人值守驱动方式」。真实实现的复杂度几乎全在工程侧——独立的事件类型、Structured Outputs 的强约束、runner 上的权限收紧、云端环境的隔离与产物回收——而不是在 loop 本身。吃透「换驱动者 + 换出口，loop 不变」这一条，这套表面就看懂了。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
