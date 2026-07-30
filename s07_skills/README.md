# s07: 技能 — 知识按需加载，别全塞进系统提示

[中文](README.md) · [English](README.en.md)

`s01` → `s02` → `s03` → `s04` → `s05` → [s06](../s06_subagents/) → `s07` → [s08](../s08_context_compact/) → ... → s20
> *"Load knowledge on demand, not all up front"* — 用到的时候才把说明书注入上下文。
>
> **Harness 层**：规划 —— 按需加载知识，不堆满上下文。

---

## 问题

你的项目有一套 React 组件规范、一份 SQL 风格指南、一套 Conventional Commits 提交格式。你希望 Agent 自动遵守它们。最直接的想法是全塞进系统提示：

```ts
const INSTRUCTIONS =
  "You are a coding agent. " +
  read("docs/react-style.md") +      // 2000 行
  read("docs/sql-style.md") +        // 1500 行
  read("docs/commit-format.md");     // 800 行
```

四千多行系统提示。Agent 每一轮调用都带着这些文档——不管它是在改一个 CSS 颜色，还是在写一条 SQL。99% 的内容跟当前任务无关，却每一轮都在烧 token，还把真正重要的指令稀释在噪音里。

知识是需要的，但**一次性全带上**是错的。人和文档打交道也不是这样：你不会把整个 wiki 背下来，而是先知道「有这么一份规范」，用到的时候再去翻。

---

## 解决方案

![Skills](images/skills.svg)

把知识做成**技能**（skill）：一个 `SKILL.md` 文件，开头用 YAML frontmatter 写明 `name` 和 `description`，正文是完整规则。harness 做**两级加载**：

| 层 | 内容 | 进上下文的时机 | 代价 |
|----|------|----------------|------|
| ① 目录 | 每个技能的 `name` + `description` | 启动时扫描 `skills/`，拼进系统提示 | 每个技能几个 token，每轮常驻 |
| ② 正文 | 整个 `SKILL.md` 的完整规则 | 任务匹配时，模型调用 `load_skill(name)` | 几千 token，**只在需要时**付 |

模型每轮都能看到「我有哪些技能可用」（便宜的目录），但不背任何一份正文。等它判断「这个任务要用提交规范了」，才调一次 `load_skill`，把那份完整说明作为一次 `function_call_output` 注入上下文——和读一个文件一样自然。

关键：正文**不是系统提示的一部分**，它是一次工具结果。用到才花 token，用不到就一分钱不花。

---

## 工作原理

在 s01 的循环上加一个「扫描 + 加载」机制，分步来看：

**第 1 步**：启动时扫描 `skills/` 目录，解析每个 `SKILL.md` 的 frontmatter，只把 `name` + `description` 收进注册表（正文先存着，不进提示）。

```ts
type Skill = { name: string; description: string; content: string };
const SKILL_REGISTRY = new Map<string, Skill>();

function scanSkills(): void {
  for (const dir of subdirsOf(SKILLS_DIR)) {
    const raw = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const meta = parseFrontmatter(raw);            // 读出 name / description
    SKILL_REGISTRY.set(meta.name, { name: meta.name, description: meta.description, content: raw });
  }
}
scanSkills(); // 只在启动时跑一次
```

**第 2 步**：把**目录**（不是正文）拼进系统提示。模型每轮都看得见有哪些技能，代价极低。

```ts
const INSTRUCTIONS =
  `You are a coding agent. Available skills:\n` +
  [...SKILL_REGISTRY.values()].map((s) => `- ${s.name}: ${s.description}`).join("\n") +
  `\nWhen the task matches a skill's description, call load_skill to fetch its full instructions.`;
```

**第 3 步**：`load_skill` 工具按名字从注册表取回**完整正文**。走注册表而不是文件路径，模型给的只是一个键，没有路径遍历风险。

```ts
function loadSkill(name: string): string {
  const skill = SKILL_REGISTRY.get(name);
  if (!skill) return `Skill not found: ${name}.`;
  return skill.content;                            // 完整 SKILL.md 作为工具结果返回
}
```

**第 4 步**：循环里按工具名分发。`load_skill` 返回的正文被当作 `function_call_output` 喂回线程，模型接着按里面的规则干活。

```ts
if (call.name === "load_skill") {
  result = loadSkill(args.name);     // 注入完整技能说明
} else {
  result = runShell(args.command);   // 真正干活
}
input.push({ type: "function_call_output", call_id: call.call_id, output: result });
```

组装起来：启动 → 扫描出目录进系统提示 → 模型看到任务匹配某技能 → 调 `load_skill` → 完整规则进上下文 → 按规则执行。本章自带两个示例技能（`code-review`、`commit-message`），离线 demo 会把「匹配 → 加载 → 照做」完整演一遍。

**核心洞察**：技能不是「更大的系统提示」，而是**把知识从「常驻成本」变成「按需成本」**。目录让模型知道「有什么」，正文让它知道「怎么做」——前者便宜到可以每轮都带，后者贵到只在真正需要时才付。

---

## 试一下

> **教学 demo 提示**：本章从 `s07_skills/skills/` 读取两个示例技能（`code-review`、`commit-message`）。离线 demo 会执行 `git status --short` 来演示「加载技能后照它做」。

**无需 API key 也能跑**：没有 `OPENAI_API_KEY` 时，内置离线模型会判断任务匹配哪个技能、调 `load_skill` 注入完整规则、再按规则跑一条命令收尾。

**准备**（首次运行）：

```sh
npm install
cp .env.example .env        # 想跑真实模型就填入 OPENAI_API_KEY 和 MODEL_ID
```

**运行**：

```sh
npx tsx s07_skills/code.ts                # 离线 demo 模型
OPENAI_API_KEY=sk-... npx tsx s07_skills/code.ts   # 真实模型
```

试试这些 prompt：

1. `Review my changes`（匹配 `code-review`）
2. `Write a commit message for what's staged`（匹配 `commit-message`）
3. `What skills are available?`（只读目录，不加载正文）

观察重点：启动时打印扫描到了几个技能？任务匹配时有没有出现 `[skill loaded]`？完整 `SKILL.md` 是不是只在你需要它之后才进上下文（而不是一开始就在系统提示里）？

---

## 接下来

按需加载解决了「不该提前带的不要带」。但另一个问题来了：Agent 连续工作半小时后，消息列表塞满了中间过程——旧的工具结果、过时的文件内容，占着上下文却不再产生价值。

s08 Context Compact → 上下文快满时自动压缩：把旧的轮次总结成一条紧凑的摘要，腾出空间继续干。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库（`codex-rs`，Rust 实现）的整体结构。教学版的「扫描目录 + 按需加载」是 Codex 技能机制的最小骨架；技能的加载与注入逻辑主要在 core 一侧，且这一能力仍在快速演进，下面是架构层面的对照。

**教学版的 `load_skill` ≈ Codex 的技能加载。** 下面每一项都是在这个核心上做的扩展。

<details>
<summary>一、技能来源：不止一个 skills/ 目录</summary>

教学版只扫一个本地 `skills/`。Codex 会从多个位置发现技能，并按作用域分层：`~/.codex/skills` 是**用户级**（对所有项目生效），项目里的 `.agents/skills` 是**项目级**（只对本仓库生效），再叠加内置技能。多个来源汇合后去重、合并成一份目录。教学版用单目录还原「从磁盘发现技能」这件事，分层与合并留给读者按真实实现去理解。

</details>

<details>
<summary>二、frontmatter：name + description 是目录的钥匙</summary>

教学版只解析 `name` 和 `description` 两个字段——这正是一个技能被「列进目录」所需的最小信息：名字用来调用，描述用来让模型判断「什么时候该用它」。真实实现的 frontmatter 字段更丰富（随版本演进），但 `name` / `description` 始终是目录层的核心。教学版的 `parseFrontmatter` 只取这两个，是刻意的简化。

</details>

<details>
<summary>三、两级加载的本质：把知识从常驻成本变成按需成本</summary>

Codex 的系统提示本来就装着不少东西（内置指令、`AGENTS.md` 等，见 s10）。如果把每份技能正文也塞进去，系统提示会无限制膨胀。技能机制的回答和教学版一致：**目录常驻、正文按需**——模型先看到一份便宜的技能清单，判断需要时才把完整说明拉进上下文。教学版用「`load_skill` 返回正文作为 `function_call_output`」还原这条路径；正文一旦进入历史，就和普通工具结果一样随对话携带，直到被压缩（见 s08）或会话结束。

</details>

<details>
<summary>四、技能 vs. AGENTS.md：常驻指令与按需知识的分工</summary>

`AGENTS.md`（s10）是**常驻**的项目级指令——编码规范、构建命令这类「永远适用」的约定，每次会话都该在场。技能则是**按需**的专业知识——只有某类任务才用得上的流程。两者互补：把「永远要遵守的」放进常驻指令，把「用到才需要的」做成技能按需加载。教学版本章只讲技能这一半，常驻指令的组装留给 s10。

</details>

**一句话**：Codex 的技能机制核心就是「启动扫描出目录 → 模型按需加载正文」。真实的技能来源、frontmatter 字段与注入细节比这丰富，但「目录便宜常驻、正文昂贵按需」这条主干没变。先看清这条主干，细节自然展开。

</details>

<!-- translation-sync: zh@v1, en@v1 -->
