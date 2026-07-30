#!/usr/bin/env tsx
/**
 * s26_local_models_providers/code.ts — Local Models & Custom Providers
 *
 * Part II: the REAL Codex product surface. So far every chapter assumed the model
 * lived at OpenAI. But `codex --oss --local-provider ollama` runs the SAME harness
 * against a local open-source model, and `[model_providers.x]` in config.toml points
 * it at any compatible gateway. The loop never changes — only the PROVIDER and the
 * WIRE API (the HTTP dialect it speaks) do:
 *
 *        the one agent loop (s01)  — provider-agnostic, speaks Responses items
 *                         │
 *              ┌──────────┴───────────┐
 *        wire_api = "responses"   wire_api = "chat"   ← the adapter is the ONLY
 *              │                      │                  part that knows the dialect
 *     POST {base}/responses     POST {base}/chat/completions  (translated both ways)
 *              │                      │
 *   openai · corp gateway ·     a chat-only backend via a translation proxy
 *   ollama :11434 · lmstudio :1234   (what LiteLLM does — Codex itself is
 *                                     responses-only now; "chat" was removed)
 *
 * This chapter builds a provider registry + a wire_api adapter, then runs the SAME
 * scripted task over openai / a corp gateway / local ollama / a chat-only backend,
 * printing each wire request so you SEE the dialect change while the loop does not.
 *
 * ACCURACY NOTE (verified against codex v0.144.6): current Codex speaks ONLY the
 * Responses wire — `wire_api = "chat"` errors with "no longer supported" (see
 * openai/codex discussion #7782). Local providers (ollama, lmstudio) must expose a
 * Responses-compatible endpoint; a chat-only backend needs a translation proxy. The
 * chat adapter below MODELS that proxy so you can see what the wire_api layer hides.
 *
 * Run it (offline, no key needed — scripted backends drive the loop):
 *     npm install
 *     npx tsx s26_local_models_providers/code.ts
 *     OPENAI_API_KEY=sk-... npx tsx s26_local_models_providers/code.ts   # real OpenAI run
 */

import OpenAI from "openai";
import { execSync } from "node:child_process";

const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

// ── NEW in s26: the provider registry ───────────────────────────────────────
// Mirrors `ModelProviderInfo` + the built-ins in codex-rs. `openai`, `ollama`,
// `lmstudio` are RESERVED ids — a custom [model_providers.x] may not reuse them.
type WireApi = "responses" | "chat";

interface ModelProviderInfo {
  id: string;
  name: string; // model_providers.<id>.name
  baseUrl: string; // model_providers.<id>.base_url
  envKey?: string; // model_providers.<id>.env_key (local providers need no key)
  wireApi: WireApi; // model_providers.<id>.wire_api — real Codex: responses only
  local?: boolean; // reached via --oss / --local-provider
}

const REGISTRY: Record<string, ModelProviderInfo> = {
  openai: { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY", wireApi: "responses" },
  // Built-in OSS providers (codex --oss --local-provider <id>). Both speak the
  // Responses wire in current Codex; Ollama/LM Studio added Responses endpoints.
  ollama: { id: "ollama", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", wireApi: "responses", local: true },
  lmstudio: { id: "lmstudio", name: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", wireApi: "responses", local: true },
};

// Register a custom provider from a [model_providers.<id>] block (config.toml).
function defineProvider(id: string, p: Omit<ModelProviderInfo, "id">): ModelProviderInfo {
  if (["openai", "ollama", "lmstudio"].includes(id))
    throw new Error(`provider id "${id}" is reserved — pick another name in [model_providers.${id}]`);
  const info = { id, ...p };
  REGISTRY[id] = info;
  return info;
}

// What REAL Codex does when it loads your config: reject anything but responses.
function assertCodexCompatible(p: ModelProviderInfo): void {
  if (p.wireApi !== "responses")
    console.log(
      dim(`  [real codex] wire_api = "${p.wireApi}" is no longer supported. ` +
        `How to fix: set wire_api = "responses" in your provider config (discussion #7782) — ` +
        `or put a translation proxy in front of "${p.id}".`)
    );
}

// ── The one tool (a shell), unchanged since s01 ─────────────────────────────
const TOOLS = [
  {
    type: "function" as const,
    name: "shell",
    description: "Run a shell command and return stdout.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function runShell(command: string): string {
  try {
    return String(execSync(command, { timeout: 30_000 })).trim() || "(no output)";
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Canonical Responses-shaped items (the loop's native tongue) ─────────────
type Item =
  | { role: string; content: string }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "message"; content: { type: string; text?: string }[] };

interface CodexRequest {
  model: string;
  instructions: string;
  input: Item[];
  tools: typeof TOOLS;
}

// ── NEW in s26: the wire_api adapter ────────────────────────────────────────
// encode: canonical request -> the provider's HTTP dialect. decode: back again.
function encodeRequest(p: ModelProviderInfo, req: CodexRequest): { url: string; body: Record<string, unknown> } {
  if (p.wireApi === "responses")
    return { url: `${p.baseUrl}/responses`, body: { model: req.model, instructions: req.instructions, input: req.input, tools: req.tools } };
  // chat: translate Responses items -> chat.completions messages (a proxy's job).
  const messages: Record<string, unknown>[] = [{ role: "system", content: req.instructions }];
  for (const i of req.input) {
    if ("role" in i) messages.push({ role: i.role, content: i.content });
    else if (i.type === "function_call")
      messages.push({ role: "assistant", tool_calls: [{ id: i.call_id, type: "function", function: { name: i.name, arguments: i.arguments } }] });
    else if (i.type === "function_call_output") messages.push({ role: "tool", tool_call_id: i.call_id, content: i.output });
    else if (i.type === "message") messages.push({ role: "assistant", content: i.content.map((c) => c.text ?? "").join("") });
  }
  const tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return { url: `${p.baseUrl}/chat/completions`, body: { model: req.model, messages, tools } };
}

function decodeResponse(p: ModelProviderInfo, raw: Record<string, unknown>): Item[] {
  if (p.wireApi === "responses") return (raw.output as Item[]) ?? [];
  // chat: translate the assistant message back into Responses items.
  const msg = (raw.choices as { message: Record<string, unknown> }[])[0].message;
  const out: Item[] = [];
  for (const tc of (msg.tool_calls as { id: string; function: { name: string; arguments: string } }[]) ?? [])
    out.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
  if (typeof msg.content === "string" && msg.content) out.push({ type: "message", content: [{ type: "output_text", text: msg.content }] });
  return out;
}

// ── Transport: a scripted dialect-aware backend offline; the real API online ─
function fakeBackend(p: ModelProviderInfo, body: Record<string, unknown>): Record<string, unknown> {
  // ONE shared "model brain": turn 1 calls shell once, then answers citing who served it.
  const answer = `[offline demo] Done — ran one shell call. Served by ${p.name} at ${p.baseUrl} ` +
    `over wire_api=${p.wireApi}${p.local ? " (a LOCAL model — no OpenAI involved)" : ""}. The loop above never changed.`;
  const cmd = { command: `echo '${p.id} backend reached'` };
  if (p.wireApi === "responses") {
    const done = (body.input as Item[]).some((i) => "type" in i && i.type === "function_call_output");
    return done
      ? { output: [{ type: "message", content: [{ type: "output_text", text: answer }] }] }
      : { output: [{ type: "function_call", id: "c1", call_id: "c1", name: "shell", arguments: JSON.stringify(cmd) }] };
  }
  const done = (body.messages as Record<string, unknown>[]).some((m) => m.role === "tool");
  return done
    ? { choices: [{ message: { role: "assistant", content: answer } }] }
    : { choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: JSON.stringify(cmd) } }] } }] };
}

async function callProvider(p: ModelProviderInfo, req: CodexRequest): Promise<Item[]> {
  const { url, body } = encodeRequest(p, req);
  console.log(dim(`  → ${p.wireApi}  POST ${url}`));
  console.log(dim(`    ${JSON.stringify(body).slice(0, 120)}…`));
  if (!OFFLINE && p.id === "openai") {
    const client = new OpenAI(); // real Responses API — the provider's native wire
    const resp = await client.responses.create({ model: req.model, instructions: req.instructions, input: req.input as never, tools: req.tools });
    return resp.output as unknown as Item[];
  }
  return decodeResponse(p, fakeBackend(p, body)); // local/custom/chat: scripted backend
}

// ── The agent loop (s01) — provider-agnostic, one line unchanged ────────────
async function agentLoop(p: ModelProviderInfo, task: string): Promise<void> {
  const input: Item[] = [{ role: "user", content: task }];
  const model = p.local ? "gpt-oss:20b" : process.env.MODEL_ID ?? "gpt-5-codex";
  for (let step = 0; step < 8; step++) {
    const output = await callProvider(p, { model, instructions: "You are Codex. Use the shell tool, act, then report.", input, tools: TOOLS });
    input.push(...output);
    const calls = output.filter((i): i is Extract<Item, { type: "function_call" }> => "type" in i && i.type === "function_call");
    if (calls.length === 0) {
      for (const i of output) if ("type" in i && i.type === "message") for (const c of i.content) if (c.text) console.log(`  ${c.text}`);
      return;
    }
    for (const call of calls) {
      const { command } = JSON.parse(call.arguments) as { command: string };
      console.log(`  \x1b[33m$ ${command}\x1b[0m`);
      input.push({ type: "function_call_output", call_id: call.call_id, output: runShell(command) });
    }
  }
}

// ── Entry point: the SAME task over four providers ──────────────────────────
async function main(): Promise<void> {
  defineProvider("corp", { name: "Corp Gateway", baseUrl: "https://llm.corp.example/v1", envKey: "CORP_API_KEY", wireApi: "responses" });
  defineProvider("legacy-chat", { name: "Legacy Chat-only", baseUrl: "http://localhost:8000/v1", wireApi: "chat" });

  console.log("s26: Local Models & Custom Providers — one loop, any backend");
  console.log(OFFLINE ? "Offline demo: scripted backends. Same task, four providers:\n" : "OPENAI_API_KEY set: OpenAI run is real; local/chat runs stay scripted.\n");

  const task = "check the backend and tell me what served you";
  for (const id of ["openai", "corp", "ollama", "legacy-chat"]) {
    const p = REGISTRY[id];
    console.log(cyan(`── provider: ${p.id} (${p.name}) ──`));
    assertCodexCompatible(p);
    await agentLoop(p, task);
    console.log();
  }
  console.log("The loop, the tool, and the task were identical every time — only the provider and wire_api changed.");
}

main();
