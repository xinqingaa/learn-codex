# s19: MCP Servers — External Tools, One Standard Protocol

[中文](README.md) · [English](README.en.md)

`s01` → ... → [s18](../s18_worktree_isolation/) → [s19](../s19_mcp_servers/) → [s20](../s20_full_harness/)
> *"External tools, one standard protocol"* — discover, namespace, call; the agent never knows who wrote the tool.
>
> **Harness layer**: collaboration — Codex as an MCP **client**, turning external processes into first-class tools at session start.

---

## The Problem

From s01 to s18, the tools the model can call are almost all ones we wrote into the harness — `shell`, `write_file`. The s12 task board and the s18 worktree are **not** another model tool: a worktree is the session cwd. The capability boundary is still those built-in functions.

Now you want to plug in three **other people's** services: the company Jira, a home-grown deploy system, the team knowledge base. You can't rewrite a toolset into the harness for each one, and you certainly don't want to re-ship the agent every time you add a service.

What you need is a **standard protocol**: any external service that implements it can be called by the agent directly — no matter what language it's written in or which machine it runs on. That's MCP (Model Context Protocol).

Codex's move is not "let the model call a connect tool first". It is: **spawn the servers from config at session start**.

---

## The Solution

![MCP Tool Bridge](images/mcp-servers.svg)

Declare a server under `[mcp_servers.<name>]` in `~/.codex/config.toml` (`command` + `args`). **Before the loop starts**, the harness **spawns each server as a child process** and **reads/writes JSON-RPC 2.0 line-by-line over stdio**: first an `initialize` handshake, then `tools/list` to discover what tools it offers, then it **bridges** each one into an ordinary Responses API function tool named `mcp__<server>__<tool>`. The model calls it like any other tool; the child receives the raw `tool.name` in a `tools/call`.

The chapter adds: this file is both the client and, with `--mcp-server`, the two children. HTTP, `enabled_tools`, OAuth, and Codex-as-a-server are not this chapter.

| concept | meaning |
|---------|---------|
| `[mcp_servers.<name>]` | declares a server in config.toml: `command` + `args` (+ optional `env`) |
| spawn at session start | Codex starts them from config; the model has **no** `connect_mcp` tool |
| stdio JSON-RPC | the child exchanges JSON-RPC 2.0 **line by line** (protocol on stdout, logs on stderr) |
| `initialize` / `tools/list` | handshake + discover which tools the server offers |
| `tools/call` | actually invoke; `name` is the server's raw tool name |
| `mcp__<server>__<tool>` | the name the model sees (Codex still keeps the `mcp__` prefix), to prevent collisions |

---

## How It Works

Four pieces: the config declaration, spawning a child process and speaking JSON-RPC, the handshake + discovery, and bridging into the tool registry.

**Step 1**: what does a server look like? Just a config entry saying "which command starts it". This is exactly the shape of an `[mcp_servers.*]` table in `~/.codex/config.toml`.

```ts
const MCP_CONFIG: Record<string, { command: string; args: string[] }> = {
  docs:   { command: NODE, args: ["--import", "tsx", SELF, "--mcp-server", "docs"] },
  deploy: { command: NODE, args: ["--import", "tsx", SELF, "--mcp-server", "deploy"] },
};
```

**Step 2**: spawn the server as a child process and exchange JSON-RPC line-by-line over its stdin/stdout. The server side does just three things: answer `initialize`, report `tools/list`, and execute `tools/call`.

```ts
async function spawnMcp(name: string): Promise<McpClient> {
  const def = MCP_CONFIG[name];
  const child = spawn(def.command, def.args, { stdio: ["pipe", "pipe", "pipe"] });
  const client = new McpClient(name, child);
  await client.connect();                 // initialize handshake + tools/list discovery
  return client;
}
```

**Step 3**: handshake and discovery. `initialize` exchanges the protocol version and both sides' capabilities, then `tools/list` returns every tool definition the server exposes.

```ts
async connect(): Promise<void> {
  await this.request("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "learn-codex", version: "0.1.0" }, capabilities: {} });
  this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  this.tools = (await this.request("tools/list")).tools as McpToolDef[];
}
```

**Step 4**: bridge into the tool registry. The name the model sees is prefixed `mcp__<server>__<tool>`; the handler sends a `tools/call` to the child using the **raw `t.name`**.

```ts
function bridgeTools(client: McpClient): void {
  for (const t of client.tools) {
    register(
      fn(`mcp__${norm(client.name)}__${norm(t.name)}`, `(MCP:${client.name}) ${t.description}`, t.inputSchema),
      (args) => client.callTool(t.name, args)   // mcp__docs__search → tools/call { name: "search" }
    );
  }
}
```

`main()` calls `spawnMcp("docs")` / `spawnMcp("deploy")` **then** opens `agentLoop`. The loop driving all of this is **unchanged since s01**: it just sees a few more function tools in the registry. It doesn't know — and doesn't need to know — that behind those tools are external processes.

The core insight: **MCP is a "process ↔ tool" translation bridge.** Facing down, JSON-RPC; facing up, ordinary function tools. Adding a capability goes from "edit the harness source" to "add one line of config".

---

## Try It

> **Teaching demo note**: the code spawns **two child processes** (itself, with a `--mcp-server` flag) speaking real stdio JSON-RPC — purely local, no network, no key, and it never touches your project files.

**No API key needed**: this chapter is a **self-running demo** with no REPL. Without `OPENAI_API_KEY` it uses a built-in offline scripted model — it calls three bridged tools in sequence: query the knowledge base (`docs.search`, `docs.get_page`, annotated readOnly) and trigger a deploy (`deploy.trigger`, annotated destructive), printing the JSON-RPC traffic throughout.

**Setup** (first run):

```sh
npm install
cp .env.example .env        # fill in OPENAI_API_KEY and MODEL_ID to run the real model
```

**Run**:

```sh
npx tsx s19_mcp_servers/code.ts                # offline demo model
OPENAI_API_KEY=sk-... npx tsx s19_mcp_servers/code.ts   # real model
```

Try these tweaks:

1. Add another tool to `SERVERS.docs.tools` and `handlers` (say `list_pages`), re-run, and watch `tools/list` discover it.
2. Run with a real key and watch the model pick `mcp__*` tools on its own to answer the same question.
3. Remove the `mcp__deploy__trigger` call from the offline script and ask something unrelated to deploys — feel why a `(destructive)` tool should go through approval (back to s03). This chapter does **not** implement the approval gate.

Watch for: does every tool name carry the `mcp__<server>__` prefix? Are the three steps `initialize` → `tools/list` → `tools/call` clearly visible in the log? When the model calls `mcp__docs__search`, is that backed by a JSON-RPC `tools/call` to the `docs` child with `name: "search"`? Does the connection happen **before** the loop, or did the model call some connect tool?

---

## What's Next

At this point the agent can plug in any external tool through one standard protocol. But look back: the first 19 chapters each added **one** mechanism, scattered across 19 demos running separately — a real harness doesn't work that way.

Tools, approval, sandbox, planning, memory, sub-agents, MCP… these are meant to hang off **the same few seams** of one loop. The task board and worktrees are seams too; the capstone does not have to re-run them.

s20 Full Harness → fit representatives of the three seams back onto the same `for (;;)`, and run a narrated trace. Many mechanisms, one loop.

<details>
<summary>Into the Codex source</summary>

> The following is based on the official [Model Context Protocol](https://developers.openai.com/codex/mcp) docs and the open-source [`openai/codex`](https://github.com/openai/codex) repo (`codex-rs`). The honesty bar matches s12: the product has an MCP client; it does **not** have a `connect_mcp` model tool; `codex mcp` is **not** "serve Codex as a server".

**The chapter's `McpClient` ≈ the connection Codex keeps for each `[mcp_servers]` entry.** The extra this chapter writes: the same file plays two stdio children.

<details>
<summary>1. Codex has an MCP client, not a connect_mcp tool</summary>

Be explicit about what exists:

- **Codex has**: stdio `[mcp_servers.<name>]` (`command` / `args` / `env` / `cwd`), spawn-and-supervise **at session start**, `initialize` → `tools/list` → `tools/call`, CLI `codex mcp add|list|get|remove|login|logout` (manages **client entries in config**), and the `mcp__` prefix on model-visible names (`LEGACY_MCP_TOOL_NAME_PREFIX` in source).
- **Codex does not have**: a model tool `connect_mcp`, or "open the loop first and connect when the model asks". Connection happens when the harness starts.
- **This chapter adds**: the same file re-spawned with `--mcp-server docs|deploy` as two real stdio children; the offline model calls `search` → `get_page` → `trigger`.

`codex mcp` is a client config manager. Serving Codex **as** an MCP server (`codex mcp-server`, exposing `codex` / `codex-reply`) is s24 / s27.

</details>

<details>
<summary>2. stdio is the default; HTTP and filters are s22</summary>

The chapter uses only **stdio** — spawn a child and exchange JSON-RPC line-by-line. That is MCP's local default transport (the spec is newline-delimited, not LSP Content-Length) and how Codex talks to local servers.

A real entry can also carry startup/call timeouts, `enabled` / `required`, `enabled_tools` / `disabled_tools`, and HTTP `url` + `bearer_token_env_var`. Those keys already live in s22; this chapter does not implement them. OAuth (`codex mcp login`) is also out of scope.

</details>

<details>
<summary>3. Namespacing: prefix for the model, raw name for the child</summary>

The chapter's `mcp__<server>__<tool>` is Codex's historical naming idea, so identically named tools from two servers don't collide. The real implementation also sanitizes illegal characters and caps at 64 bytes; the child always receives the **raw `tool.name`**.

The chapter's `(readOnly)` / `(destructive)` strings live in the description, not as MCP `readOnlyHint`. They are a hook for the reader: destructive calls in real Codex still go through `approval_policy` (s03), and a server can set `default_tools_approval_mode`. This chapter does not restack approval.

</details>

<details>
<summary>4. Neighbouring chapters this one does not restack</summary>

Plugins that bundle MCP into one install are s24. `codex mcp-server` / app-server exposing the engine are s24 / s27. Sandbox (s04) still locks the current cwd — an MCP child is a different process; don't call spawn a sandbox.

MCP resources / prompts are not demonstrated here.

</details>

**In one line**: Codex starts MCP servers from config at session start and presents discovered tools as ordinary function tools; the extra this chapter writes is "the same file plays two children", so the three stdio steps are visible.

</details>

<!-- translation-sync: zh@v2, en@v2 -->
