# s10: Instructions — prompt 是组装出来的，不是写死的

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s09](../s09_memory_sessions/) → `s10` → [s11](../s11_error_recovery/) → `s12` → ... → s20
> *"The prompt is assembled, not written"* — system prompt 在运行时按层拼装，而不是焊死在源码里。
>
> **Harness 层**：规划 —— 同一个 harness，换个项目或配置就有不同的行为。

---

## 问题

从 s01 到 s09，system prompt 都是一行硬编码：

```ts
const INSTRUCTIONS = `You are a coding agent running in ${CWD}. Use the shell tool ...`;
```

s01 够用。但 Agent 越长大，三个痛点越明显：

1. **换项目要重写整段 prompt**——不知道哪些该改、哪些该留。
2. **「配置」混在代码里**——模型、推理档位、审批策略、沙箱模式全硬编码在源码，想换个模型得改代码。
3. **项目自己的规矩没地方放**——「提交信息用祈使句」「收尾前先跑 `git status`」这类约定属于项目，只能塞进 harness，一换项目就错。

问题不在 prompt 写得不好，而在 **harness 把「一段字符串」当成了配置**。它该像真正的配置一样：分层、可覆盖、运行时解析。

---

## 解决方案

![Instruction Assembly](images/instructions.svg)

把 system prompt 拆成**层**，运行时按需拼装；把「选什么模型、想多深」交给一个 `config.toml` 式的配置对象去解析。两类东西分开处理：

**文本**（拼进 `instructions` 字符串）：

| 层 | 内容 | 何时生效 |
|----|------|---------|
| 内置 base | 你是谁、怎么用工具 | 永远在 |
| `AGENTS.md`（项目） | 项目自己的规矩 | 文件存在才追加在 base 之后 |

**配置**（解析成具体取值）：

| 项 | 例子 |
|----|------|
| `model` / `model_reasoning_effort` | `gpt-5-codex` / `medium` |
| `approval_policy` / `sandbox_mode` | `on-request` / `workspace-write` |

配置的**优先级**（高的覆盖低的）：

| 优先级 | 来源 | 例子 |
|--------|------|------|
| 最高 | env / CLI flag | `MODEL_ID`、`--model` |
| 中 | `--profile` | `--profile deep` |
| 低 | `config.toml` 根 / 内置默认 | `model = "..."` / `gpt-5-codex` |

关键设计：**文本合并**和**配置解析**是两条独立路径。前者决定模型「读到什么」，后者决定它「是谁、想多深」。

---

## 工作原理

把这个过程翻译成 TypeScript，分步来看：

**第 1 步**：内置 base，焊死在 harness 里，永远在。

```ts
const BASE_INSTRUCTIONS =
  `You are Codex, a coding agent running in ${CWD}. ` +
  `Use the shell tool to solve the task. Act, don't explain. ` +
  `When a project AGENTS.md is present, follow its instructions too.`;
```

**第 2 步**：项目层。读 `AGENTS.md`，存在才用。

```ts
function loadAgentsMd(): string | null {
  const p = fileURLToPath(new URL("./AGENTS.md", import.meta.url));
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}
```

**第 3 步**：配置层。一个 `config.toml` 式的对象，含 `profiles` 和 `model_providers`。

```ts
const CONFIG: CodexConfig = {
  model: "gpt-5-codex",
  model_reasoning_effort: "medium",
  approval_policy: "on-request",
  sandbox_mode: "workspace-write",
  model_providers: { openai: { name: "OpenAI", wire_api: "responses" } },
  profiles: {
    fast: { model: "gpt-5-codex", model_reasoning_effort: "low" },
    deep: { model: "gpt-5-codex", model_reasoning_effort: "high" },
  },
};
```

**第 4 步**：按优先级解析出有效配置——`--profile` 覆盖 config 根，`env` 覆盖一切。

```ts
function resolveConfig(cfg: CodexConfig, profileName?: string) {
  const profile = (profileName ? cfg.profiles?.[profileName] : undefined) ?? {};
  return {
    model: process.env.MODEL_ID ?? profile.model ?? cfg.model ?? "gpt-5-codex",
    effort: profile.model_reasoning_effort ?? cfg.model_reasoning_effort ?? "medium",
    approval_policy: cfg.approval_policy ?? "on-request",
    sandbox_mode: cfg.sandbox_mode ?? "workspace-write",
  };
}
```

**第 5 步**：合并文本层成单个 `instructions` 字符串。

```ts
function buildInstructions(): { text: string; layers: string[] } {
  const layers = ["built-in base"];
  let text = BASE_INSTRUCTIONS;
  const agents = loadAgentsMd();
  if (agents) {
    layers.push("AGENTS.md (project)");
    text += `\n\n# Project instructions (AGENTS.md)\n${agents}`;
  }
  return { text, layers };
}
```

**第 6 步**：把解析结果喂给 API——模型、instructions、推理档位都来自上面的解析，不再是字面量。

```ts
const resp = await openai.responses.create({
  model: MODEL,                 // 来自 resolveConfig，不是写死
  instructions: INSTRUCTIONS,   // 来自 buildInstructions，base + AGENTS.md
  input, tools: TOOLS,
  reasoning: { effort: EFFORT }, // 同样来自 resolveConfig
});
```

**核心洞察**：prompt 不再是焊死的字符串，而是运行时的「文本合并 + 配置解析」。换项目（换一份 `AGENTS.md`）或换档位（换一个 `--profile`），同一个 harness 的行为就变了。离线 demo 里，本章自带的 `AGENTS.md` 要求「收尾前先跑 `git status`」，脚本化模型照做了——这证明拼装出来的 prompt 真的驱动了模型的行为，而不是一段摆设。

---

## 试一下

> **教学 demo 提示**：本章会从 `s10_instructions/AGENTS.md` 读项目指令，并执行模型生成的 `git status` 命令。在本仓库或一个临时 git 仓库里跑都可以。

**无需 API key 也能跑**：没有 `OPENAI_API_KEY` 时，本章的离线 demo 启动时会打印「拼装好的 system prompt」（两层都在）和解析出的 `model / effort / approval / sandbox`；随后脚本化模型会照 `AGENTS.md` 的规矩先跑一次 `git status`。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s10_instructions/code.ts                    # 默认配置
npx tsx s10_instructions/code.ts --profile deep     # 用 deep 预设（effort=high）
OPENAI_API_KEY=sk-... npx tsx s10_instructions/code.ts   # 真实模型
```

试试这些实验：

1. 直接跑，看启动面板里 `layers` 是不是 `built-in base + AGENTS.md (project)`，以及 `resolved:` 那一行。
2. 分别加 `--profile fast` 和 `--profile deep` 跑一次，看 `effort` 怎么从 `medium` 变成 `low` / `high`。
3. 编辑 `s10_instructions/AGENTS.md`（比如把规则改成「收尾前先跑 `git diff`」），再跑，看启动面板和模型行为怎么立刻跟着变。

观察重点：`resolved:` 里的 `model` / `effort` 来自哪一层？改掉 `AGENTS.md` 之后，拼装出的 prompt 和模型行为是不是马上跟着变了？

---

## 接下来

prompt 能运行时组装了，模型和档位也能用配置切换了。但 Agent 一遇到 API 报错还是会整个崩掉——限流、过载、上下文超长、用户按 Esc 中止，这些不是 bug 而是常态，且每种的正确反应完全不同。

s11 Error Recovery → 给 `callModel` 包一层「分类重试」：限流退避、超长先压缩再试、中止立刻停。

<details>
<summary>深入 Codex 源码</summary>

> 以下内容基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构。教学版的「base + AGENTS.md 合并、config 解析出 model/effort」就是 Codex 指令装配的最小骨架；差异全在来源数量与覆盖规则的工程细节上。

**教学版的 `buildInstructions` + `resolveConfig` ≈ Codex 的指令装配与配置解析。** 下面每一项都是在这个核心上做的加固。

<details>
<summary>一、base prompt 内置在 codex-rs，且随模型变化</summary>

教学版把 base 写成一个常量字符串。Codex 的 base 指令内置在 `codex-rs` 里，而且**不是一成不变的一段**——它会根据所用模型（例如 `gpt-5-codex` 与其它模型）和配置选择不同的内置提示。换句话说「内置 base」本身就是一层可被配置影响的输入，而不只是焊死的字面量。教学版用单一常量，是为了让「永远有一层 base」这个事实一眼可见。

</details>

<details>
<summary>二、AGENTS.md 的发现与合并</summary>

教学版只读「本章目录下的一份 AGENTS.md」。Codex 的约定更宽：它会查找项目里的 `AGENTS.md`（项目级指令），也支持全局的 `~/.codex/AGENTS.md`，把这些项目/用户级的指令**合并**进发给模型的指令或上下文里。核心思想和教学版一致——base 在先、项目约定追加在后；真实实现只是支持了更多来源和更完整的查找规则。

</details>

<details>
<summary>三、config.toml：model、effort、policies、profiles、providers</summary>

教学版的 `CONFIG` 对象对应真实的 `~/.codex/config.toml`。它支持的键包括 `model`、`model_reasoning_effort`、`approval_policy`、`sandbox_mode`，以及 **`profiles`**（一组命名预设，用 `--profile` 选择，可覆盖根上的取值）和 **`model_providers`**（自定义提供方，含 `wire_api`，用于把 Codex 指到兼容的网关而非默认 API）。教学版把这些都放进一个对象字面量，是为了不引入 TOML 解析也能讲清「分层 + 覆盖」的结构。

</details>

<details>
<summary>四、优先级：CLI > profile > config 根 > 内置默认</summary>

教学版用「`env` > `--profile` > config 根 > 默认」演示覆盖顺序。Codex 的真实规则同向：**命令行**（如 `-c key=value`、`--model`、`--profile`）优先于 `config.toml`；`profile` 里的取值优先于配置文件根上的同名取值；内置默认值兜底。env 变量（如 `MODEL_ID`）在教学版里扮演了「最高优先级覆盖」的角色，对应真实世界里的 CLI/环境覆盖。理解「后 applied 的层覆盖先 applied 的层」这一条，就看懂了整套解析。

</details>

**一句话**：Codex 的指令装配核心就是教学版这套「base + AGENTS.md 合并成 instructions，config 解析出 model/effort/policies，按优先级覆盖」。所有额外机制——多模型的内置提示、多来源的 AGENTS.md、TOML 与 profiles/providers、更细的覆盖规则——都是为了让这套装配在真实多项目、多模型的使用里既灵活又可预期。先吃透「分层 + 覆盖 = 可配置的 prompt」这一条，其余都是工程加固。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
