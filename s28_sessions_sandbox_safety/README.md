# s28: Sessions, Sandbox & Safety 深潜 —— 会话的一生 + 自治刻度盘

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s23](../s23_review_ci_cloud/) → ... → [s27](../s27_codex_service_surfaces/) → `s28`
> *"One dial from 'ask me everything' to 'just run it'"* —— 安全不是一道开关，而是四道闸门叠成的一个「能不能跑」的决定。
>
> **Harness 层**:Codex 深潜 —— 换的不是 loop，而是「一个动作要闯过几道闸，才被允许执行」。

---

## 问题

Part I 我们把 loop 拆到底，Part II 一路走来:s21 看了命令面，s22 把 `config.toml` 的旋钮解析了一遍，s23 看到 loop 怎么无人值守地跑在 review、CI 和云上。但有两个问题一直悬着：

1. **会话跑完去哪了?** 你昨天半夜跑到一半的会话、上周那个试了一半的实验——它们没消失，都是落盘的 rollout。问题是：怎么接着跑(`resume`)?怎么在一个好状态上分个叉、试错又不毁原会话(`fork`)?怎么把不常用的收起来但不删(`archive`)?什么时候才真的删掉(`delete`)?没有一个清晰的生命周期模型，几十个会话很快就变成一团乱麻。

2. **「放手让它跑」到底是一个动作，还是一串决定?** 一边是完全不敢放权——每条命令都亲手批;另一边是 `--dangerously-bypass-approvals-and-sandbox`——什么都不问、还不套沙箱。中间隔着一大片：只读沙箱、可写工作区、`--add-dir` 额外放行、实验特性要不要开、这个项目可不可信、要不要再加一道 guardian 复审。**真正的 Codex 把这片连续谱，收敛成「一个动作 + 一组配置 → 一个 allow / ask / deny」的判定。** 问题是：这几道闸——feature flag、bypass、沙箱、审批/信任——按什么顺序叠，又怎么合成一个决定?

这两个问题其实是同一个:**自治(autonomy)不是开或关，而是一个刻度盘。** 会话生命周期管的是「哪段对话接着活」；安全解析器管的是「这个动作能不能跑」。本章把两件一起讲透。

---

## 解决方案

![Sessions, Sandbox & Safety](images/sessions-sandbox-safety.svg)

**第一件：会话生命周期。** 每次运行都是一条持久化的 rollout(s09 的 `.jsonl`),CLI 给它一组管理命令。关键区分:`fork` 是**分叉**(源会话原封不动，副本独立演化),`archive` 只是**藏起来**(rollout 还在盘上，`--all` 仍可见),只有 `delete` 才是**永久删除**。

| 命令 | 干什么 | 关键点 |
|------|--------|--------|
| `codex resume [--last\|<SESSION>] [PROMPT]` | 重载一个会话并继续 | 默认弹选择器；`--last` 直接接最近一次；`--all` 关掉按 cwd 过滤 |
| `codex fork [--last\|<SESSION>] [PROMPT]` | **分叉**一个会话 | 复制一份带全部历史的新会话，`parentId` 指向源；源会话不受影响 |
| `codex archive <SESSION>` | 归档(隐藏) | 只是设个标志，从默认选择器里隐去；**不删数据** |
| `codex unarchive <SESSION>` | 取消归档 | 重新可见 |
| `codex delete <SESSION>` | **永久删除** | 唯一不可逆的操作 |
| `<SESSION>` 参数 | UUID 或会话名 | **UUID 优先**:能解析成 UUID 就按 UUID 匹配，否则按名字 |

**第二件：安全解析器。** 每个动作(shell 命令 / hook / 工具调用)在执行前，按**固定顺序**闯四道闸，任何一道都能直接 `deny`;全过了才轮到「要不要问人」:

| 闸门 | 由什么控制 | 真实开关 | 不满足时 |
|------|-----------|----------|----------|
| 0 · hook 信任 | 项目信任 / 已持久化的 hook 信任 | `[projects."<path>"]` · `--dangerously-bypass-hook-trust` | `deny`(hook 是来自配置的代码，先要信任) |
| 1 · feature 闸 | 特性是否生效 | `--enable/--disable <FEATURE>` · `codex features enable\|disable` | `deny`(能力是关的) |
| 2 · 总旁路 | 一键跳过沙箱+审批 | `--dangerously-bypass-approvals-and-sandbox` | 设了就直接 `allow`(极度危险) |
| 3 · 沙箱闸 | 文件系统/网络物理边界 | `-s, --sandbox <MODE>` · `--add-dir <DIR>` | `deny`(越界了，物理上不让) |
| 4 · 审批/信任/复审 | 要不要问人 | `-a, --ask-for-approval <POLICY>` · 项目信任 · `guardian_approval` | `ask`(升级给人)或 `allow` |

**`sandbox_mode`(`-s, --sandbox`)三档**(真实后端是 macOS 的 Seatbelt / Linux 的 Landlock，见 s04):

| 模式 | 写 | 网络 | 一句话 |
|------|----|------|--------|
| `read-only` | 全部拒绝 | 拒绝 | 只能看，不能动 |
| `workspace-write` | 工作区 + `--add-dir` 根内允许 | 默认关 | 默认干活的档 |
| `danger-full-access` | 不限 | 不限 | 没有沙箱边界 |

**`approval_policy`(`-a, --ask-for-approval`)**:CLI 的 `-a` 接受 `untrusted` / `on-request` / `never`;`config.toml` 里的 `approval_policy` 还多一个 `on-failure`。

| 策略 | 语义 |
|------|------|
| `untrusted` | 只有「受信」只读命令(`ls`/`cat`/`sed`…)不用问；模型提出别的就升级给人 |
| `on-request` | 由模型决定何时请人批准 |
| `on-failure` | 先跑，**失败了**才问(仅 config 文件) |
| `never` | 永不问；执行失败立刻回给模型 |

**两个 `dangerously` 旁路(为什么危险)**:它们不是「更方便」，而是**亲手拆掉 harness 给你搭的护栏**——只在「外部环境本身已经隔离」(一次性容器、CI runner)时才该用。

| flag | 跳过什么 | 真实警告原文 |
|------|----------|--------------|
| `--dangerously-bypass-approvals-and-sandbox` | 所有确认提示 + 沙箱 | "Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY DANGEROUS. Intended solely for running in environments that are externally sandboxed." |
| `--dangerously-bypass-hook-trust` | hook 的持久化信任要求 | "Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS." |

**`guardian_approval`(一道额外审批层)**:这是一个 stable 特性(`codex features list` 里 `guardian_approval = stable, true`)。它在审批策略**之上**再加一名「复审者」——哪怕 `approval_policy=never` 本已放行，只要动作有风险，guardian 仍把它扳回 `ask`。

**feature flag 是实验能力的总开关**:`codex features list` 列出每个特性的「阶段 + 生效状态」;`codex features enable/disable <FEATURE>` 把它写进 `config.toml`(等价于 `-c features.<name>=true/false`,也等价于 CLI 的 `--enable/--disable <FEATURE>`)。在 v0.144.6 上实测:`browser_use`、`computer_use`、`image_generation`、`goals`、`hooks`、`guardian_approval`、`fast_mode`、`apps`、`code_mode_host` 等都是 `stable`;**`memories` 是 `experimental`(默认关)**,`network_proxy`、`prevent_idle_sleep` 也是 `experimental`;还有一批 `under development`。阶段越靠前，越需要你显式去开。

**信任(trust)分两层**:`[projects."<path>"]` 的 `trust_level = trusted/untrusted` 标记整个项目/工作树(受信项目还会加载项目级 `.codex/config.toml`,但不能覆盖机器级的 provider/auth/telemetry);**hook 信任**是另一层——hook 是来自配置的代码，光有项目信任或已持久化的 hook 信任才跑，否则拒绝，`--dangerously-bypass-hook-trust` 可临时跳过。

---

## 工作原理

把两件事翻译成 TypeScript。

**第 1 步**：会话记录 + 一个按「UUID 优先、其次按名字」解析的存储。`archived` 只是可见性标志，`parentId` 记录分叉来源。

```ts
interface SessionRec {
  id: string;             // 真实 Codex 里是 UUID；这里用短 id 代替
  name: string; cwd: string; createdAt: number;
  parentId: string | null; // fork 时指向源会话
  archived: boolean;       // 归档 = 从选择器隐藏，不是删除
  turns: string[];         // rollout：每完成一轮追加一条
}
```

**第 2 步**：生命周期操作。`fork` 复制全部历史成一份独立副本(源不动);`archive`/`unarchive` 只翻标志;`delete` 才真正移除。

```ts
fork(idOrName: string, prompt?: string): SessionRec | undefined {
  const src = this.find(idOrName);
  if (!src) return undefined;
  const copy: SessionRec = {
    id: this.newId(), name: `${src.name}-fork`, cwd: src.cwd, createdAt: Date.now(),
    parentId: src.id, archived: false, turns: [...src.turns], // 共享历史，然后各自演化
  };
  if (prompt) copy.turns.push(`user: ${prompt}`);
  this.byId.set(copy.id, copy);
  return copy;
}
// resume 往里追加一轮；setArchived 只翻 archived 标志；remove 才是永久删除。
```

**第 3 步**：安全解析器的输入——一份 `SafetyConfig`(把四道闸的开关都收进来)和一个待判的 `Action`。

```ts
interface SafetyConfig {
  sandboxMode: SandboxMode;      // -s, --sandbox
  approval: ApprovalPolicy;      // -a, --ask-for-approval(config 还允许 on-failure)
  projectTrust: Trust;           // [projects."<path>"].trust_level
  hookTrustPersisted: boolean;
  bypassApprovalsAndSandbox: boolean; // --dangerously-bypass-approvals-and-sandbox
  bypassHookTrust: boolean;           // --dangerously-bypass-hook-trust
  guardianApproval: boolean;          // features.guardian_approval —— 额外审批层
  workspace: string; addDirs: string[]; // 主工作区 + --add-dir
  features: Record<string, { stage: FeatureStage; enabled: boolean }>;
}
interface Action { kind: "shell" | "hook"; command: string;
  writesTo?: string; network?: boolean; needsFeature?: string; }
```

**第 4 步**:`canRun` —— 本章核心。四道闸按序执行，任何一道 `deny` 立即返回;全过了再由审批/信任/guardian 决定 `allow` 还是 `ask`。

```ts
function canRun(cfg: SafetyConfig, a: Action): Decision {
  // 闸 0 · hook 信任：--dangerously-bypass-hook-trust 直接放行；否则要项目受信或已持久化信任
  // 闸 1 · feature 闸：a.needsFeature 对应特性没生效 → deny(提示 codex features enable)
  // 闸 2 · 总旁路：bypassApprovalsAndSandbox → 直接 allow(跳过沙箱与审批，极度危险)
  // 闸 3 · 沙箱闸：read-only 拒绝一切写/网；workspace-write 拒绝工作区+addDirs 之外的写、默认断网；danger-full-access 不设边界
  // 闸 4 · 审批/信任：never→allow · on-failure→先跑 · untrusted→只放受信只读命令否则 ask · on-request→风险则 ask
  //   再叠两层：guardian_approval 把风险的 allow 扳回 ask；untrusted 项目永不自动跑写/网动作
}
```

**核心洞察**：安全不是一道「允许/拒绝」的开关，而是**一个有优先级的判定流水线**。顺序很关键——feature 闸最靠前(能力没开，根本轮不到谈沙箱);总旁路紧随其后(它存在的意义就是短路后面全部);沙箱在审批之前(物理边界比「问不问人」更硬，越界的写连问都不必问);审批与信任垫底(决定要不要把一个本来能跑的动作再升级给人)。guardian_approval 和 untrusted-project 是两枚「保险丝」,钉在最后，确保任何路径下风险动作都不会被静默放行。离线 demo 里你能逐条看到：同一条 `tee /etc/hosts`,默认 `deny`、加了 `--add-dir /etc` 就变 `ask`;同一条 `rm -rf build`,`never` 时 `allow`、一开 guardian 就被扳回 `ask`。

---

## 试一下

> **教学 demo 提示**：本章是纯内存的——会话存储和安全解析器都在进程里模拟，不碰你的文件系统，也不真的执行任何命令。

**无需 API key 也能跑**：本章机制是确定性的(一个存储 + 一个策略解析器),**不需要模型**,所以全程离线、无任何网络调用。`main()` 是一段自运行的旁白演示，先把生命周期五个操作走一遍，再跑一组「同配置换动作 / 同动作换配置」的安全判定矩阵。

**准备**(首次运行):

```sh
npm install
```

**运行**:

```sh
npx tsx s28_sessions_sandbox_safety/code.ts
```

试试这些实验：

1. 直接跑，看 Part 1:`fork` 之后源会话 `turns` 不变、副本独立加了一条;`archive` 之后默认列表里消失、`list(true)` 里还在;`delete` 之后连 `--all` 都没了。
2. 看 Part 2 的「同一条 `tee /etc/hosts`」三连：默认 `deny` → 加 `--add-dir /etc` 后 `ask`。再对比「`memories` 关着 `deny` → `enable` 后放行」。
3. 在 `code.ts` 里改 `base` 配置(比如把 `approval` 改成 `untrusted`、`sandboxMode` 改成 `read-only`),重跑，看哪些动作从 `allow` 掉到 `ask`、哪些直接 `deny`。

观察重点:`canRun` 返回的 `reasons` 数组，逐条记录了「是哪一道闸、基于哪个开关」做出的决定——这正是真实 Codex 在拒绝或追问时该给你的解释。

---

## 接下来

到这里，Part II 的深潜走完了：从 s21 的命令面、s22 的 `config.toml`、s23 的无人值守表面，到本章的「会话生命周期 + 自治刻度盘」。你已经看清了 Codex 的两副面孔——**对用户**是一组子命令和斜杠命令，**对安全**是一条层层设闸的判定流水线。

如果这是你的终点，那就回到起点，把 s01 到本章拼成**你自己的** agent:拿 [s01](../s01_agent_loop/) 那个 30 行的 loop 做骨架，按 s02–s20 逐层加机制，再用 Part II 的真实表面(CLI、`config.toml`、exec/review/cloud、生命周期与安全闸)把它对准真实的工作。想重看那个 loop，就去 [s01](../s01_agent_loop/)。

<details>
<summary>深入 Codex 源码</summary>

> 以下基于 OpenAI 开源的 [`openai/codex`](https://github.com/openai/codex) 仓库(`codex-rs`,Rust 实现)的整体结构，以及本地安装的 `codex` CLI(v0.144.6)的 `--help` / `features list` 真实输出。教学版的「会话存储 + 四闸解析器」是这套表面的最小骨架；真实实现的复杂度在工程细节(rollout 的落盘格式、Seatbelt/Landlock 的系统调用、信任与 hook 的持久化)上。

**教学版的 `SessionStore` ≈ 真实的 rollout 存储与生命周期子命令；教学版的 `canRun` ≈ 真实执行前的「审批 + 沙箱」裁定。** 下面每一项都是在这个核心上的展开。

<details>
<summary>一、会话落盘为 rollout,生命周期子命令只管「文件与索引」</summary>

真实 Codex 把每次会话持久化成 `$CODEX_HOME`(默认 `~/.codex`)下的 rollout 文件(s09 讲过这个模型)。`codex resume` / `fork` / `archive` / `unarchive` / `delete` 这些子命令并不重造 agent——它们只是**对落盘的 rollout 做索引与文件操作**:`resume` 重新加载并续跑;`fork` 复制出一份带新会话 id 的副本(源不动);`archive`/`unarchive` 把它挪进/挪出「归档」那一档(从默认选择器隐藏);`delete` 才真正删文件。教学版用内存 `Map` + 一个 `archived` 标志模拟的，正是这套「元数据操作，不碰 loop」的设计。`<SESSION>` 参数「UUID 优先、否则按名字」也来自真实 `--help`。

</details>

<details>
<summary>二、沙箱是真内核强制,不是应用层 if</summary>

教学版用 `under(root, path)` 判断「写是否越界」。真实 `codex-rs` 在 macOS 上用 **Seatbelt**(`sandbox-exec`)、Linux 上用 **Landlock** 把 `sandbox_mode` 翻译成内核级的文件系统/网络策略——拒绝发生在系统调用层，进程想绕也绕不过去。`codex sandbox [COMMAND]` 这条子命令(真实 `--help`:"Run commands within a Codex-provided sandbox",命令「run under seatbelt」)让你**手动**把任意命令套进同一套沙箱里跑，配合 `--sandbox-state-readable-root`(可重复)、`--sandbox-state-disable-network`、`-P/--permission-profile` 等微调。`--add-dir <DIR>` 则把额外目录加进可写根集合——教学版 `addDirs` 数组模拟的就是它。

</details>

<details>
<summary>三、审批策略与「受信命令集」</summary>

`approval_policy` 的 `untrusted` 档之所以「只放 `ls`/`cat`/`sed` 不用问」,是因为真实实现里维护了一个**只读受信命令集**;模型提出集合之外的命令就升级给用户。`on-request` 把「何时问」交给模型判断,`on-failure` 先跑、失败才问,`never` 全不问。教学版的 `TRUSTED_CMD` 正则和四分支 `switch` 就是这个裁定的最小骨架。真实实现里审批还与会话的工作区信任、网络开关等叠加,`guardian_approval`(stable 特性)则是在其上再加一道独立复审——教学版用「风险动作的 allow 被扳回 ask」建模了这层「额外审批者」。

</details>

<details>
<summary>四、feature flag 是分阶段的能力总开关</summary>

真实 `codex features list` 把每个特性标成 `stable` / `experimental` / `under development` / `deprecated` / `removed`,并显示当前是否生效;`codex features enable/disable <FEATURE>` 写进 `config.toml` 的 `[features]` 表(等价 `-c features.<name>=true/false` 与 `--enable/--disable`)。实验特性(如 v0.144.6 的 `memories`)默认关，必须显式开。教学版把「能力 = 一道最靠前的闸」建模成 `canRun` 的 GATE 1:特性没生效，连后面的沙箱/审批都轮不到。

</details>

<details>
<summary>五、两个 dangerously 旁路与「外部已隔离」的前提</summary>

`--dangerously-bypass-approvals-and-sandbox` 的真实警告原文点明了它的唯一合法用途:"Intended solely for running in environments that are externally sandboxed"——也就是一次性容器、CI runner 这类**环境本身已经隔离**的地方。它跳过的不只是「问不问」,还有内核级沙箱，所以在本机日常用等于裸奔。`--dangerously-bypass-hook-trust` 同理:hook 是配置里定义的代码，正常要先建立持久化信任才跑，这个 flag 临时跳过这道信任——教学版的 GATE 0 把它建模成「仅本次调用生效的放行」。

</details>

**一句话**:会话生命周期和安全解析器都不是新 agent——前者是对落盘 rollout 的「文件级」管理，后者是执行前一条「按序设闸」的判定流水线。真实实现的硬核在工程侧(内核沙箱、持久化信任、特性分阶段),而教学版要传达的是同一件事:**自治是一个刻度盘，不是一个开关；每一道闸都有名字，也都该给你一个理由。**

</details>

<!-- translation-sync: zh@v1, en@v1 -->
