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
const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

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
    const out = execSync(command, { cwd: CWD, timeout: 120_000, maxBuffer: 1024 * 1024 });
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

// Offline scripted model: one turn that mixes a safe write with a DANGEROUS
// command, so you can watch the policy hold the dangerous one for approval.
function offlineModel(input: unknown[]): OutputItem[] {
  const ran = input.filter((i) => (i as { type?: string }).type === "function_call_output").length;
  const call = (id: string, name: string, args: Record<string, unknown>): OutputItem => ({
    type: "function_call",
    id,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  });
  if (ran === 0) {
    return [
      call("c1", "write_file", { path: "agent_scratch/keep.txt", content: "keep me\n" }),
      call("c2", "shell", { command: "rm -rf agent_scratch" }), // danger: held for approval
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
            `[offline demo] policy=${POLICY}: the model attempted a safe write AND a dangerous ` +
            `\`rm -rf\`. ${denials} call(s) were held and denied, each returning an error item ` +
            `to the model; the rest ran. Try APPROVAL_POLICY=untrusted|on-failure|never. ` +
            `Set OPENAI_API_KEY for a real model.`,
        },
      ],
    },
  ];
}

// ── The agent loop: s02's dispatch, now gated by approval_policy ──────────
type Confirm = (question: string) => Promise<boolean>;

async function agentLoop(input: unknown[], confirm: Confirm): Promise<void> {
  for (;;) {
    const output = await callModel(input);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output) {
        if (item.type === "message") {
          for (const c of item.content ?? []) {
            if (c.type === "output_text" && c.text) console.log(c.text);
          }
        }
      }
      return;
    }

    for (const call of calls) {
      const risk = classify(call);
      console.log(`\x1b[33m-> ${call.name}(${summarize(call.arguments ?? "")})\x1b[0m  [risk=${risk}]`);

      // NEW in s03: the gate. Hold the call if the policy says so.
      if (needsApprovalUpFront(POLICY, risk)) {
        const ok = await confirm(`\x1b[31mhold [${POLICY}]\x1b[0m ${call.name} risk=${risk}. Allow?`);
        if (!ok) {
          const err = `Error: denied by approval_policy (${POLICY})`;
          console.log(`\x1b[31m✗ denied — error item fed back to the model\x1b[0m`);
          input.push({ type: "function_call_output", call_id: call.call_id, output: err });
          continue; // the model sees the denial and can choose a safer path
        }
      }

      let result = dispatch(call.name ?? "", call.arguments ?? "{}");

      // on-failure: nothing is held up front; a FAILURE is what triggers the ask.
      if (POLICY === "on-failure" && result.startsWith("Error")) {
        const retry = await confirm(`\x1b[31mcall failed [on-failure]\x1b[0m retry with approval?`);
        if (retry) result = dispatch(call.name ?? "", call.arguments ?? "{}") + "\n(escalated after failure)";
      }

      console.log(result.split("\n").slice(0, 6).join("\n"));
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
}

function summarize(argsJson: string): string {
  try {
    const a = JSON.parse(argsJson) as Args;
    return String(a.path ?? a.command ?? "").slice(0, 60);
  } catch {
    return argsJson.slice(0, 60);
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
      ? `Offline demo model (no OPENAI_API_KEY). approval_policy=${POLICY}. Type a task, or q to quit.\n`
      : `Model: ${MODEL}. approval_policy=${POLICY}. Type a task, or q to quit.\n`
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
