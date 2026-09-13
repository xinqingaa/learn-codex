#!/usr/bin/env tsx
/**
 * s03_approval/code.ts — approval_policy: a Gate Before Execution (Codex-style)
 *
 * s02 gave the model five tools that all run the moment they're called. Real
 * harnesses put an approval gate in front of execution. Codex exposes it as
 * `approval_policy` with four modes; the harness classifies each call, and the
 * policy decides whether to run it, hold it for a human, or ask only on failure:
 *
 *     function_call
 *         |
 *         v
 *     classify(call)  ->  read | write | danger
 *         |
 *         v
 *     approval_policy decides:
 *       never        -> run everything, ask nothing
 *       on-failure   -> run; only ask when a call FAILS (escalate?)
 *       on-request   -> hold only `danger` calls for a y/n
 *       untrusted    -> hold anything that isn't a pure read
 *         |
 *    denied? -> feed an error item back to the model (the loop goes on)
 *
 * Each turn prints the raw `output` array, then classify + the gate, then
 * dispatch. Offline mode ignores the prompt and writes .tmp/s03/keep.txt
 * (same story as the web simulator), then proposes `rm -rf .tmp/s03` so the
 * default on-request policy holds the dangerous call for y/n.
 *
 * Run it:
 *     npm install
 *     npx tsx s03_approval/code.ts                  # offline demo (policy: on-request)
 *     APPROVAL_POLICY=untrusted npx tsx s03_approval/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s03_approval/code.ts   # real model
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const MODEL = process.env.MODEL_ID ?? "gpt-5-codex";
const CWD = process.cwd();
const TMP_DIR = path.join(CWD, ".tmp", "s03");
const KEEP_REL = path.join(".tmp", "s03", "keep.txt");
const TMP_REL = path.join(".tmp", "s03");
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const MODEL_LABEL = OFFLINE ? "offline" : MODEL;

// ── NEW in s03: approval_policy ───────────────────────────────────────────
// The four Codex modes, read from config (here: an env var, like config.toml).
type Policy = "untrusted" | "on-failure" | "on-request" | "never";
const POLICY: Policy = (process.env.APPROVAL_POLICY as Policy) ?? "on-request";

// A call's risk class, decided by the harness (not by trusting the model).
type Risk = "read" | "write" | "danger";
const DANGER = ["rm ", "rm -", "sudo", "mkfs", "dd ", "shutdown", "reboot", "> /dev/", "> /etc/", "chmod 777"];
const READ_ONLY = ["ls", "cat", "pwd", "echo", "grep", "find", "head", "tail", "wc", "git status", "git log", "git diff"];

function classify(call: OutputItem): Risk {
  const args = JSON.parse(call.arguments ?? "{}") as { command?: string };
  if (call.name === "read_file" || call.name === "list_dir") return "read";
  if (call.name === "shell") {
    const cmd = (args.command ?? "").trim();
    if (DANGER.some((d) => cmd.includes(d))) return "danger";
    if (READ_ONLY.some((r) => cmd.startsWith(r))) return "read";
    return "write";
  }
  return "write"; // write_file, apply_patch and any unknown tool mutate state
}

// Does this policy hold this call for a human BEFORE it runs?
function needsApprovalUpFront(policy: Policy, risk: Risk): boolean {
  switch (policy) {
    case "never":
      return false; // ask nothing — full trust
    case "on-request":
      return risk === "danger"; // the model escalates only clearly-dangerous ops
    case "untrusted":
      return risk !== "read"; // most cautious: hold anything that isn't a pure read
    case "on-failure":
      return false; // run first; ask only if it FAILS (handled after dispatch)
  }
}

const INSTRUCTIONS =
  `You are a coding agent in ${CWD}. Use the tools to solve the task. ` +
  `If a call is denied, accept it and continue with a safe alternative.`;

// ── Tools (the s02 registry, trimmed to three to keep the focus on the gate) ──
const TOOLS = [
  {
    type: "function" as const,
    name: "read_file",
    description: "Read a UTF-8 file and return its text.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "write_file",
    description: "Write content to a file, creating parent directories as needed.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function" as const,
    name: "shell",
    description: "Run a shell command and return its combined stdout+stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const resolvePath = (p: string): string => path.resolve(CWD, p);
function runReadFile(p: string): string {
  return fs.readFileSync(resolvePath(p), "utf8").slice(0, 50_000) || "(empty file)";
}
function runWriteFile(p: string, content: string): string {
  const f = resolvePath(p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return `Wrote ${content.length} bytes to ${p}`;
}
function runShell(command: string): string {
  try {
    const out = execSync(command, {
      cwd: CWD,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return (String(out).trim() || "(no output)").slice(0, 50_000);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    return `Error: ${e.stderr?.toString().trim() || e.message || err}`;
  }
}

type Args = Record<string, unknown> & { path?: string; command?: string };
const TOOL_HANDLERS: Record<string, (a: Args) => string> = {
  read_file: (a) => runReadFile(String(a.path)),
  write_file: (a) => runWriteFile(String(a.path), String(a.content)),
  shell: (a) => runShell(String(a.command)),
};
function dispatch(name: string, argsJson: string): string {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return `Error: unknown tool '${name}'`;
  try {
    return handler(JSON.parse(argsJson) as Args);
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Model adapter (Responses API output items, online or offline) ─────────
type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const SCRIPT_TOOL_COUNT = 2; // one turn: write_file + rm -rf

function countToolResults(input: unknown[]): number {
  return input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
}

function countToolResultsSinceLastUser(input: unknown[]): number {
  let lastUser = -1;
  for (let i = 0; i < input.length; i++) {
    if ((input[i] as { role?: string }).role === "user") lastUser = i;
  }
  return input
    .slice(lastUser + 1)
    .filter((i) => (i as { type?: string }).type === "function_call_output").length;
}

function printOutput(output: OutputItem[]): void {
  const json = JSON.stringify(
    output,
    (_key, value) =>
      typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…` : value,
    2,
  );
  console.log(dim("  output:"));
  for (const line of json.split("\n")) console.log(dim(`  ${line}`));
}

function previewToolOutput(result: string, maxLines = 20): void {
  const all = result.split("\n");
  if (result === "(no output)" || result === "") {
    console.log(dim("  │ （成功，无 stdout）"));
    return;
  }
  const shown = all.slice(0, maxLines);
  for (const line of shown) console.log(dim(`  │ ${line}`));
  const hidden = all.length - shown.length;
  if (hidden > 0) {
    console.log(dim(`  │ … ${hidden} more lines（完整结果在 thread 里）`));
  }
}

function printHarnessCall(call: OutputItem): void {
  let args: Args = {};
  try {
    args = JSON.parse(call.arguments ?? "{}") as Args;
  } catch {
    args = {};
  }
  console.log(dim("  harness:"));
  if (call.name === "shell") {
    console.log(yellow(`  $ ${String(args.command ?? "")}`));
    return;
  }
  const pathArg = args.path != null ? `  path=${args.path}` : "";
  console.log(yellow(`  ${call.name ?? "?"}${pathArg}`));
}

const openai = OFFLINE ? null : new OpenAI();
async function callModel(input: unknown[]): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: MODEL,
      instructions: INSTRUCTIONS,
      input: input as never,
      tools: TOOLS,
      reasoning: { effort: "medium" },
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(input);
}

// Scripted stand-in: same story as the web simulator.
// Ignores the user text. One turn: a safe write + a dangerous rm -rf.
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = countToolResultsSinceLastUser(input);
  const alreadyPlayed = countToolResults(input) >= SCRIPT_TOOL_COUNT && ran === 0;
  const turn = input.filter((i) => (i as { role?: string }).role === "user").length;

  const call = (id: string, name: string, args: Record<string, unknown>): OutputItem => ({
    type: "function_call",
    id,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  });

  if (alreadyPlayed) {
    return [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text:
              `[offline demo] 这条进程里的固定剧本已经演完（写 ${KEEP_REL} → rm -rf ${TMP_REL}）。` +
              `刚才不是听懂了你的话。输入 q 退出；设 OPENAI_API_KEY 后工具才会跟着问题变。`,
          },
        ],
      },
    ];
  }

  if (ran === 0) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
    return [
      call(`call_${turn}_1`, "write_file", { path: KEEP_REL, content: "keep me\n" }),
      call(`call_${turn}_2`, "shell", { command: `rm -rf ${TMP_REL}` }), // danger: held under on-request
    ];
  }

  const denials = input.filter((i) =>
    (i as { output?: string }).output?.includes("denied by approval_policy")
  ).length;
  return [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text:
            `[offline demo] policy=${POLICY}：同一轮里一次安全写入 ${KEEP_REL}，一次危险的 \`rm -rf ${TMP_REL}\`。` +
            `${denials} 个调用被门拦住并拒绝，错误 item 喂回模型；其余已执行。` +
            `这是固定剧本，不是在回答你刚打的字。试 APPROVAL_POLICY=untrusted|on-failure|never。` +
            `设 OPENAI_API_KEY 后，工具才会跟着问题变——循环和 dispatch 不变，只是 dispatch 前多了这道门。`,
        },
      ],
    },
  ];
}

// ── The agent loop: s02's dispatch, now gated by approval_policy ──────────
type Confirm = (question: string) => Promise<boolean>;

async function agentLoop(input: unknown[], confirm: Confirm): Promise<void> {
  const lastUser = [...input].reverse().find((i) => (i as { role?: string }).role === "user") as
    | { content?: unknown }
    | undefined;
  if (typeof lastUser?.content === "string") console.log(dim(`  user: ${lastUser.content}`));
  if (OFFLINE) {
    const replay = countToolResults(input) >= SCRIPT_TOOL_COUNT;
    console.log(
      dim(
        replay
          ? "[offline] 剧本已演过，不再重复执行工具。"
          : `[offline] 不读你刚打的字。固定演示：写 ${KEEP_REL}（write）+ rm -rf ${TMP_REL}（danger）。policy=${POLICY}`
      )
    );
  }
  let turn = 0;
  for (;;) {
    turn += 1;
    const output = await callModel(input);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    console.log(cyan(`── turn ${turn} ──`));
    console.log(dim(`  模型: ${MODEL_LABEL}`));
    printOutput(output);

    if (calls.length === 0) {
      for (const item of output) {
        if (item.type === "message") {
          for (const part of item.content ?? []) {
            if (part.type === "output_text" && part.text) console.log("message: " + part.text);
          }
        }
      }
      return;
    }

    if (calls.length > 1) {
      console.log(dim(`  本轮 ${calls.length} 个 function_call → 同一轮 fan-out，每个都先过审批门再 dispatch`));
    }

    for (const call of calls) {
      const risk = classify(call);
      printHarnessCall(call);
      console.log(dim(`  classify: risk=${risk}  policy=${POLICY}`));

      // NEW in s03: the gate. Hold the call if the policy says so.
      if (needsApprovalUpFront(POLICY, risk)) {
        console.log(red(`  hold [${POLICY}] — 执行前问人`));
        const ok = await confirm(`hold [${POLICY}] ${call.name} risk=${risk}. Allow?`);
        if (!ok) {
          const err = `Error: denied by approval_policy (${POLICY})`;
          previewToolOutput(err);
          console.log(red("  已写回 function_call_output（denied）→ continue"));
          input.push({ type: "function_call_output", call_id: call.call_id, output: err });
          continue; // the model sees the denial and can choose a safer path
        }
        console.log(green("  用户允许 → dispatch"));
      }

      let result = dispatch(call.name ?? "", call.arguments ?? "{}");

      // on-failure: nothing is held up front; a FAILURE is what triggers the ask.
      if (POLICY === "on-failure" && result.startsWith("Error")) {
        const retry = await confirm(`call failed [on-failure] retry with approval?`);
        if (retry) result = dispatch(call.name ?? "", call.arguments ?? "{}") + "\n(escalated after failure)";
      }

      previewToolOutput(result);
      console.log(green("  已写回 function_call_output → continue"));
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

// ── Entry point: a minimal REPL ───────────────────────────────────────────
// A shared line queue: piped input is buffered and NEVER dropped, so an
// approval answer typed (or piped) mid-loop is always delivered to the gate.
function createLineReader(): { question(prompt: string): Promise<string | null>; close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  rl.on("line", (line) => (waiters.length ? waiters.shift()?.(line) : queue.push(line)));
  rl.on("close", () => {
    while (waiters.length) waiters.shift()?.(null);
  });
  return {
    question(prompt) {
      process.stdout.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift()!);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}

async function main(): Promise<void> {
  console.log("s03: approval_policy — a Gate Before Execution (Codex-style)");
  console.log(
    OFFLINE
      ? `Offline demo model (no OPENAI_API_KEY). approval_policy=${POLICY}. Type a task, or q to quit.`
      : `Model: ${MODEL}. approval_policy=${POLICY}. Type a task, or q to quit.`
  );
  console.log(
    dim(
      OFFLINE
        ? "output: 是返回值。dispatch 前先 classify + 审批门。没 key：不读提示词，固定演示写入 .tmp/s03/ 再提议 rm -rf。\n"
        : "output: 是返回值。dispatch 前先 classify + 审批门。\n"
    )
  );

  const io = createLineReader();
  // A deny-by-default confirm: anything that isn't an explicit "y" means no.
  const confirm: Confirm = async (question) => {
    const ans = await io.question(`\x1b[35m? ${question} [y/N] \x1b[0m`);
    return ["y", "yes"].includes((ans ?? "").trim().toLowerCase());
  };

  const thread: unknown[] = [];
  for (;;) {
    const query = await io.question("\x1b[36ms03 >> \x1b[0m");
    if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) break;
    thread.push({ role: "user", content: query });
    console.log();
    try {
      await agentLoop(thread, confirm);
    } catch (err) {
      console.error("agent error:", err);
    }
    console.log();
  }
  io.close();
}

main();
