#!/usr/bin/env tsx
/**
 * s25_builtin_tools/code.ts — Tools Beyond the Shell
 *
 * In s02 we built a tool registry and concluded it held ~5 local function tools,
 * all variations on "read or change the filesystem / run a command". The real
 * Codex ships far more than a shell. Alongside `shell` it registers multimodal
 * and *action* tools that reach outside the workspace:
 *
 *   tool              kind      really runs where?              gated by
 *   ────────────────  ────────  ──────────────────────────────  ─────────────────────
 *   shell             local     your machine (sandboxed)        approval_policy
 *   web_search        hosted    OpenAI's side (Responses tool)  --search flag (no per-call approval)
 *   view_image        local     reads a workspace image file    -i/--image attaches to a prompt
 *   image_generation  hosted    OpenAI's side (gpt-image)       features.image_generation
 *   browser_use       action    a real browser, driven via CDP  features.browser_use(+_external,_full_cdp_access,in_app_browser)
 *   computer_use      action    your desktop GUI (screenshots+input) features.computer_use
 *
 * Same registry, same dispatch-by-name as s02 — only now some tools are *hosted*
 * (the model emits the call, OpenAI executes it, the harness just threads the
 * result back) and some are *action* tools (the harness drives a browser or the
 * desktop itself). This chapter extends the s02 registry to model all of them.
 *
 * Run it (offline, no key needed — a scripted model drives the loop):
 *     npm install
 *     npx tsx s25_builtin_tools/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s25_builtin_tools/code.ts   # real model
 */

import OpenAI from "openai";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

type OutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

// ── NEW in s25: a registry that knows *where* a tool really runs ────────────
// s02's registry mapped name → handler. We add metadata: the `kind` (local /
// hosted / action), how it is gated, and a one-line note about what the real
// Codex tool does. The dispatch loop never branches on this — it is metadata
// the harness (and this demo's narration) uses, exactly like the real CLI's
// feature flags decide which tools get registered at all.
type ToolKind = "local" | "hosted" | "action";

interface ToolSpec {
  kind: ToolKind;
  gatedBy: string; // the real flag / feature that turns this tool on
  note: string; // what the real Codex tool actually does
  description: string; // model-facing description
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => string; // teaching-model executor
}

class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  register(name: string, spec: ToolSpec): void {
    this.tools.set(name, spec);
  }

  // The Responses-API function-tool list the model sees.
  functionTools() {
    return [...this.tools.entries()].map(([name, t]) => ({
      type: "function" as const,
      name,
      description: t.description,
      parameters: t.parameters,
      strict: true,
    }));
  }

  entries(): [string, ToolSpec][] {
    return [...this.tools.entries()];
  }

  dispatch(name: string, argsJson: string): string {
    const t = this.tools.get(name);
    if (!t) return `Error: unknown tool ${name}`;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    } catch {
      return `Error: bad arguments for ${name}`;
    }
    console.log(`\x1b[35m⚙ ${name}\x1b[0m \x1b[90m[${t.kind} · gated by ${t.gatedBy}]\x1b[0m`);
    console.log(`\x1b[90m   real Codex: ${t.note}\x1b[0m`);
    return t.run(args);
  }
}

// ── The workspace: a scratch dir with one real (tiny) image to look at ──────
const WORKSPACE = mkdtempSync(join(tmpdir(), "codex-s25-"));
// A minimal valid 1x1 PNG so view_image has a real file to open.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
writeFileSync(join(WORKSPACE, "screenshot.png"), PNG_1PX);

// ── NEW in s25: register Codex's multimodal / action tools ──────────────────
function registerBuiltinTools(reg: ToolRegistry): void {
  reg.register("web_search", {
    kind: "hosted",
    gatedBy: "--search (live web search, no per-call approval)",
    note: "the native Responses `web_search` tool — OpenAI runs the search server-side and streams back cited results.",
    description: "Search the live web and return summarized results with citations.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query." } },
      required: ["query"],
      additionalProperties: false,
    },
    run: ({ query }) =>
      `[simulated web results for "${query}"] 1. TypeScript 5.9 released — deferred import evaluation. 2. …`,
  });

  reg.register("view_image", {
    kind: "local",
    gatedBy: "-i/--image to attach; agent re-opens workspace images",
    note: "attaches a local image so the multimodal model can *see* it (the -i/--image flag does this for the first prompt).",
    description: "Open a local image file and attach it to the conversation so you can see it.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path to the image file in the workspace." } },
      required: ["path"],
      additionalProperties: false,
    },
    run: ({ path }) => {
      const bytes = statSync(join(WORKSPACE, String(path))).size;
      return `[attached ${path} — ${bytes} bytes, now visible to the model] a 1x1 test image, all-transparent pixel.`;
    },
  });

  reg.register("image_generation", {
    kind: "hosted",
    gatedBy: "features.image_generation (stable)",
    note: "the Responses image-generation tool (gpt-image) — OpenAI renders the image server-side.",
    description: "Generate an image from a text prompt and save it into the workspace.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", description: "What to draw." } },
      required: ["prompt"],
      additionalProperties: false,
    },
    run: ({ prompt }) => {
      writeFileSync(join(WORKSPACE, "hero.png"), PNG_1PX); // simulated render
      return `[generated hero.png from "${prompt}" → saved to workspace]`;
    },
  });

  reg.register("browser_use", {
    kind: "action",
    gatedBy: "features.browser_use (+_external, _full_cdp_access, in_app_browser)",
    note: "drives a real browser over the Chrome DevTools Protocol: navigate, click, read the DOM, screenshot.",
    description: "Control a web browser: navigate to a URL, read the page, click elements.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "e.g. navigate, click, read." },
        target: { type: "string", description: "URL or selector." },
      },
      required: ["action", "target"],
      additionalProperties: false,
    },
    run: ({ action, target }) =>
      `[browser ${action} ${target} via CDP] page title "TypeScript 5.9 announcement", 12 links, 1 code block.`,
  });

  reg.register("computer_use", {
    kind: "action",
    gatedBy: "features.computer_use (stable)",
    note: "operates the whole desktop GUI: screenshot → model reasons → mouse/keyboard events, in a loop.",
    description: "Operate the desktop GUI: take a screenshot, move/click the mouse, type keys.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", description: "e.g. screenshot, click, type." } },
      required: ["action"],
      additionalProperties: false,
    },
    run: ({ action }) => `[desktop ${action}] screenshot captured (1440x900); cursor at (512, 384).`,
  });
}

// ── Model adapter: real Responses API, or a scripted offline stand-in ───────
const openai = OFFLINE ? null : new OpenAI();
const registry = new ToolRegistry();
registerBuiltinTools(registry);

async function callModel(thread: OutputItem[]): Promise<OutputItem[]> {
  if (!OFFLINE && openai) {
    const resp = await openai.responses.create({
      model: process.env.MODEL_ID ?? "gpt-5-codex",
      instructions:
        "You are Codex. You have multimodal + action tools beyond the shell: web_search, " +
        "view_image, image_generation, browser_use, computer_use. Use them, act, don't explain.",
      input: thread as never,
      tools: registry.functionTools(),
    });
    return resp.output as unknown as OutputItem[];
  }
  return offlineModel(thread);
}

// Offline stand-in: walk a fixed script that calls each builtin tool once, then
// answer. This is what lets the demo run end-to-end with no API key.
function offlineModel(thread: OutputItem[]): OutputItem[] {
  const ran = thread.filter((i) => i.type === "function_call_output").length;
  const script: { name: string; arguments: string }[] = [
    { name: "web_search", arguments: JSON.stringify({ query: "latest TypeScript release highlights" }) },
    { name: "view_image", arguments: JSON.stringify({ path: "screenshot.png" }) },
    { name: "browser_use", arguments: JSON.stringify({ action: "navigate", target: "https://devblogs.microsoft.com/typescript/" }) },
    { name: "image_generation", arguments: JSON.stringify({ prompt: "hero banner for a TS 5.9 release post" }) },
    { name: "computer_use", arguments: JSON.stringify({ action: "screenshot" }) },
  ];
  if (ran < script.length) {
    const c = script[ran];
    return [{ type: "function_call", id: `c${ran}`, call_id: `c${ran}`, name: c.name, arguments: c.arguments }];
  }
  const text =
    "[offline demo] Done. I searched the live web (hosted `web_search`, no per-call approval), " +
    "looked at screenshot.png (view_image / the -i flag), drove a real browser over CDP (browser_use), " +
    "generated hero.png (hosted image_generation), and read the desktop (computer_use). " +
    "None of these touched the shell — the registry from s02 just grew new kinds of tools. " +
    "Set OPENAI_API_KEY for a real model; the registry and dispatch are identical.";
  return [{ type: "message", content: [{ type: "output_text", text }] }];
}

// ── The core loop, unchanged from s01/s02: dispatch tool calls by name ──────
async function agentLoop(task: string): Promise<void> {
  const thread: OutputItem[] = [{ type: "message", content: [{ type: "input_text", text: task }] } as OutputItem];
  for (;;) {
    const output = await callModel(thread);
    thread.push(...output);
    const calls = output.filter((i) => i.type === "function_call");
    if (calls.length === 0) {
      for (const item of output)
        if (item.type === "message")
          for (const c of item.content ?? []) if (c.type === "output_text" && c.text) console.log(`\n${c.text}`);
      return;
    }
    for (const call of calls) {
      const result = registry.dispatch(call.name ?? "", call.arguments ?? "{}");
      console.log(`   \x1b[32m→\x1b[0m ${result}`);
      thread.push({ type: "function_call_output", call_id: call.call_id, output: result } as OutputItem);
    }
  }
}

// ── Entry point: a self-running, narrated demo ──────────────────────────────
async function main(): Promise<void> {
  console.log("s25: Tools Beyond the Shell — one registry, new kinds of tools\n");
  console.log(OFFLINE ? "Offline demo model.\n" : "Real model.\n");
  console.log(`Registered tools (kind · gate):`);
  for (const [name, spec] of registry.entries()) {
    console.log(`  ${name.padEnd(18)} ${spec.kind.padEnd(7)} ${spec.gatedBy}`);
  }
  console.log();
  await agentLoop(
    "Research the latest TypeScript release, look at my screenshot.png, open the announcement " +
      "page in a browser, generate a hero image, and check what's on my desktop."
  );
  console.log(`\nWorkspace artifacts: screenshot.png (input), hero.png (generated).`);
}

main();
