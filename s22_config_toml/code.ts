#!/usr/bin/env tsx
/**
 * s22_config_toml/code.ts — config.toml in Depth (Codex-style, in TypeScript)
 *
 * Part II: the REAL Codex product surface. Codex is configured by one file,
 * ~/.codex/config.toml, holding every knob: model & effort, model_providers
 * (base_url / env_key / wire_api), approval_policy, sandbox_mode +
 * sandbox_workspace_write, profiles, mcp_servers, tui, history, project trust.
 * The file is half the story — the other half is ONE resolver walking a fixed
 * precedence chain (last layer to define a key wins, and we record WHICH):
 *
 *   built-in default < config.toml root < --profile NAME < -c key=value / CLI flags
 *
 * The offline demo parses a realistic config.toml, then prints the effective
 * config for three flag/profile combos so you SEE one file resolve three ways.
 *     npm install
 *     npx tsx s22_config_toml/code.ts                                  # narrated demo, no key
 *     npx tsx s22_config_toml/code.ts --profile deep -c sandbox_mode=read-only
 *     OPENAI_API_KEY=sk-... npx tsx s22_config_toml/code.ts --profile deep   # real API tail
 */

import OpenAI from "openai";

const OFFLINE = !process.env.OPENAI_API_KEY || process.env.CODEX_OFFLINE === "1";

// ── NEW in s22: a tiny TOML-subset parser ───────────────────────────────────
// Real Codex uses a full TOML crate. We only need the subset config files use:
// scalars, strings, arrays, inline tables, and [dotted.table] headers (quoted
// segments allowed, for project paths containing dots/slashes).
type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };
type TomlTable = { [k: string]: TomlValue };

function stripComment(line: string): string {
  let inStr = false, q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { if (c === q && line[i - 1] !== "\\") inStr = false; }
    else if (c === '"' || c === "'") { inStr = true; q = c; }
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}
// Split on a separator at bracket/brace depth 0 and outside strings.
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, inStr = false, q = "", cur = "";
  for (const c of s) {
    if (inStr) { cur += c; if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; cur += c; continue; }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== "");
}
function parseKey(k: string): string {
  const t = k.trim(), q = t[0];
  return (q === '"' || q === "'") && t[t.length - 1] === q ? t.slice(1, -1) : t;
}
function parseValue(raw: string): TomlValue {
  const s = raw.trim();
  if (s.startsWith('"') || s.startsWith("'")) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith("[") && s.endsWith("]")) return splitTop(s.slice(1, -1), ",").map(parseValue);
  if (s.startsWith("{") && s.endsWith("}")) {
    const t: TomlTable = {};
    for (const pair of splitTop(s.slice(1, -1), ",")) {
      const eq = pair.indexOf("=");
      t[parseKey(pair.slice(0, eq))] = parseValue(pair.slice(eq + 1));
    }
    return t;
  }
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s; // lenient: a bare word (e.g. a `-c effort=high` value) becomes a string
}
// "a.b.\"c.d\"" -> ["a", "b", "c.d"]: dots inside quotes are not separators.
function parseHeader(inner: string): string[] {
  return splitTop(inner, ".").map(parseKey);
}
function resolvePath(root: TomlTable, path: string[]): TomlTable {
  let cur = root;
  for (const key of path) {
    const next = cur[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cur[key] = {};
    cur = cur[key] as TomlTable;
  }
  return cur;
}
function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  for (const raw of src.split("\n")) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = resolvePath(root, parseHeader(line.slice(1, -1)));
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    current[parseKey(line.slice(0, eq))] = parseValue(line.slice(eq + 1));
  }
  return root;
}

// ── NEW in s22: a realistic config.toml covering the whole schema ──────────
const CONFIG_TOML = `
# ~/.codex/config.toml — every knob, one file
model = "gpt-5-codex"
model_reasoning_effort = "medium"     # minimal | low | medium | high | xhigh
model_provider = "openai"             # id into [model_providers]
approval_policy = "on-request"        # untrusted | on-request | never | { granular = {...} }
sandbox_mode = "workspace-write"      # read-only | workspace-write | danger-full-access

[sandbox_workspace_write]             # only used when sandbox_mode = "workspace-write"
network_access = false
writable_roots = ["./fixtures"]
exclude_tmpdir_env_var = true
exclude_slash_tmp = true
[history]
persistence = "save-all"              # save-all | none
max_bytes = 1048576
[tui]
alternate_screen = "auto"             # auto | always | never
animations = true
notifications = true

# A custom provider: point Codex at a Responses-compatible gateway.
[model_providers.gateway]
name = "Corp Gateway"
base_url = "https://llm.corp.example/v1"
env_key = "GATEWAY_API_KEY"
wire_api = "responses"                # the only wire_api current Codex speaks
request_max_retries = 4

# MCP servers: one stdio (command/args/env), one streamable HTTP (url).
[mcp_servers.docs]
command = "npx"
args = ["-y", "@docs/mcp-server"]
startup_timeout_sec = 15
[mcp_servers.docs.env]
DOCS_TOKEN = "abc123"
[mcp_servers.web]
url = "https://mcp.example.com/sse"
bearer_token_env_var = "WEB_MCP_TOKEN"

# Named presets; --profile NAME merges one over the config root.
[profiles.fast]
model_reasoning_effort = "low"
approval_policy = "never"
[profiles.deep]
model = "gpt-5-pro"
model_reasoning_effort = "high"
model_provider = "gateway"
sandbox_mode = "danger-full-access"
[projects."/work/learn-codex"]            # per-project trust
trust_level = "trusted"
`;

// ── NEW in s22: the precedence chain, one resolver ─────────────────────────
// Real built-in defaults (from codex-rs): approval_policy defaults to
// on-request, sandbox_mode to read-only, provider to the built-in "openai".
const DEFAULTS: TomlTable = {
  model: "gpt-5-codex",
  model_reasoning_effort: "medium",
  model_provider: "openai",
  approval_policy: "on-request",
  sandbox_mode: "read-only",
};
const SCALAR_KEYS = ["model", "model_reasoning_effort", "model_provider", "approval_policy", "sandbox_mode"];

interface Layer { label: string; table: TomlTable }
function trace(key: string, layers: Layer[]): { value: TomlValue; source: string } {
  let value: TomlValue = "(unset)", source = "(none)";
  for (const { label, table } of layers)
    if (Object.prototype.hasOwnProperty.call(table, key)) { value = table[key]; source = label; }
  return { value, source };
}
type Resolved = { entries: Record<string, { value: TomlValue; source: string }>; profileUsed: string | null };
function resolveConfig(cfg: TomlTable, opts: { profile?: string; cli?: TomlTable }): Resolved {
  const profiles = (cfg.profiles ?? {}) as TomlTable;
  const chosen = opts.profile ? (profiles[opts.profile] as TomlTable | undefined) : undefined;
  const layers: Layer[] = [
    { label: "built-in default", table: DEFAULTS },
    { label: "config.toml root", table: cfg },
    { label: `--profile ${opts.profile}`, table: chosen ?? {} },
    { label: "CLI -c / flags", table: opts.cli ?? {} },
  ];
  const entries: Resolved["entries"] = {};
  for (const k of SCALAR_KEYS) entries[k] = trace(k, layers);
  return { entries, profileUsed: chosen ? (opts.profile as string) : null };
}
// The scalar `model_provider` is an id; resolve it to a concrete endpoint.
function resolveProvider(cfg: TomlTable, id: string) {
  const providers = (cfg.model_providers ?? {}) as TomlTable;
  if (id === "openai" && !providers[id])
    return { name: "OpenAI", base_url: "https://api.openai.com/v1", env_key: "OPENAI_API_KEY", wire_api: "responses" };
  const p = (providers[id] ?? {}) as TomlTable;
  return {
    name: String(p.name ?? id), base_url: String(p.base_url ?? "?"),
    env_key: String(p.env_key ?? "?"), wire_api: String(p.wire_api ?? "responses"),
  };
}

// ── Parse real CLI args: --profile NAME, --model M, -c key=value ───────────
function parseArgs(argv: string[]): { profile?: string; cli: TomlTable } {
  const cli: TomlTable = {};
  let profile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") profile = argv[++i];
    else if (a === "--model") cli.model = argv[++i];
    else if (a === "-c") {
      const kv = argv[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq > 0) {
        const path = parseHeader(kv.slice(0, eq)); // -c supports dotted keys too
        const leaf = path[path.length - 1];
        resolvePath(cli, path.slice(0, -1))[leaf] = parseValue(kv.slice(eq + 1));
      }
    }
  }
  return { profile, cli };
}

// ── Narrated rendering ──────────────────────────────────────────────────────
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
function showScenario(cfg: TomlTable, title: string, opts: { profile?: string; cli?: TomlTable }): void {
  const r = resolveConfig(cfg, opts);
  console.log(bold(title));
  for (const k of SCALAR_KEYS) {
    const { value, source } = r.entries[k];
    console.log(`  ${k.padEnd(24)} = ${String(value).padEnd(20)} ${dim("← " + source)}`);
  }
  const pid = String(r.entries.model_provider.value);
  const p = resolveProvider(cfg, pid);
  console.log(dim(`  provider[${pid}] → ${p.name} · ${p.base_url} · key=$${p.env_key} · wire_api=${p.wire_api}`));
  if (r.entries.sandbox_mode.value === "workspace-write") {
    const w = (cfg.sandbox_workspace_write ?? {}) as TomlTable;
    console.log(dim(`  sandbox_workspace_write → network_access=${w.network_access}, writable_roots=${JSON.stringify(w.writable_roots)}, exclude_tmpdir=${w.exclude_tmpdir_env_var}, exclude_/tmp=${w.exclude_slash_tmp}`));
  }
  const mcp = Object.keys((cfg.mcp_servers ?? {}) as TomlTable);
  const proj = ((cfg.projects ?? {}) as TomlTable)["/work/learn-codex"] as TomlTable | undefined;
  console.log(dim(`  mcp_servers: ${mcp.join(", ")} · project /work/learn-codex trust=${String(proj?.trust_level ?? "untrusted")}`));
  console.log();
}

async function main(): Promise<void> {
  const cfg = parseToml(CONFIG_TOML);
  console.log("s22: config.toml in Depth — every knob, one resolver (Codex-style)\n");
  console.log(dim("Precedence (low → high): built-in default < config.toml root < --profile < -c key=value / CLI flags\n"));

  showScenario(cfg, "① No flags — resolve from the file alone:", {});
  showScenario(cfg, "② --profile fast — the profile overrides the root:", { profile: "fast" });
  showScenario(cfg, "③ --profile deep  +  -c model_reasoning_effort=low -c sandbox_mode=read-only — CLI beats the profile:", {
    profile: "deep",
    cli: { model_reasoning_effort: "low", sandbox_mode: "read-only" },
  });

  // Live tail: resolve YOUR args, then (with a key) fire one real Responses call
  // to prove the resolved model + effort are exactly what gets sent.
  const args = parseArgs(process.argv.slice(2));
  const r = resolveConfig(cfg, args);
  const model = String(r.entries.model.value);
  const effort = String(r.entries.model_reasoning_effort.value);
  const prov = resolveProvider(cfg, String(r.entries.model_provider.value));
  console.log(bold("④ Your turn — resolved from the args you passed:"));
  console.log(`  model=${model}  effort=${effort}  provider=${prov.name} (${prov.wire_api})  profile=${r.profileUsed ?? "(none)"}`);
  if (OFFLINE) {
    console.log(dim(`  [offline demo] would POST ${prov.base_url}/responses with model="${model}", reasoning.effort="${effort}".`));
    console.log(dim("  Set OPENAI_API_KEY to fire that exact request — only the transport changes, not the resolution."));
    return;
  }
  const client = new OpenAI({ apiKey: process.env[prov.env_key] ?? process.env.OPENAI_API_KEY, baseURL: prov.base_url });
  const resp = await client.responses.create({
    model,
    input: "Reply with the single word: ok",
    reasoning: { effort: effort as never }, // resolved from config; xhigh may exceed the SDK's literal type
  });
  const text = resp.output_text?.trim() ?? "(no text)";
  console.log(`  [real API] model=${model} effort=${effort} → ${text}`);
}

main();
