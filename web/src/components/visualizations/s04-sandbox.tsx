"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  FileCode,
  FolderLock,
  Globe,
  HardDrive,
  Lock,
  OctagonAlert,
  PlayCircle,
  ShieldCheck,
  ShieldX,
  Terminal,
  Unlock,
} from "lucide-react";
import { StepControls } from "@/components/visualizations/shared/step-controls";
import { useSteppedVisualization } from "@/hooks/useSteppedVisualization";
import { cn } from "@/lib/utils";

type ModeId = "read-only" | "workspace-write" | "danger-full-access";
type OpId = "inside" | "outside";

const MODES: {
  id: ModeId;
  icon: React.ComponentType<{ size?: number | string }>;
  writeScope: string;
  network: string;
  tone: "blue" | "amber" | "red";
  blurb: string;
}[] = [
  {
    id: "read-only",
    icon: Lock,
    writeScope: "read anywhere · write nothing",
    network: "network off",
    tone: "blue",
    blurb: "The filesystem is frozen. The agent can read and reason, but every write is refused.",
  },
  {
    id: "workspace-write",
    icon: FolderLock,
    writeScope: "write inside the workspace only",
    network: "network off",
    tone: "amber",
    blurb: "The working directory is writable; anything outside it is out of bounds.",
  },
  {
    id: "danger-full-access",
    icon: Unlock,
    writeScope: "read + write anywhere",
    network: "network on",
    tone: "red",
    blurb: "No sandbox. The command runs with your full user permissions.",
  },
];

const OPERATIONS: Record<
  OpId,
  { tool: string; command: string; where: string; icon: React.ComponentType<{ size?: number | string }> }
> = {
  inside: {
    tool: "apply_patch",
    command: "patch src/app.ts",
    where: "lands inside the workspace",
    icon: FileCode,
  },
  outside: {
    tool: "shell",
    command: "echo 127.0.0.1 x >> /etc/hosts",
    where: "lands outside the workspace",
    icon: Terminal,
  },
};

const STEPS: {
  title: string;
  desc: string;
  mode: ModeId | "overview" | "summary";
  op?: OpId;
  allowed?: boolean;
}[] = [
  {
    title: "One Command, Three Sandboxes",
    desc: "sandbox_mode decides what a command may touch — before it ever runs.",
    mode: "overview",
  },
  {
    title: "read-only: Writes Are Refused",
    desc: "Under read-only the filesystem is frozen, so even an in-workspace patch is denied.",
    mode: "read-only",
    op: "inside",
    allowed: false,
  },
  {
    title: "workspace-write: Inside Is Fine",
    desc: "A patch to src/app.ts stays inside the workspace, so the OS allows it.",
    mode: "workspace-write",
    op: "inside",
    allowed: true,
  },
  {
    title: "workspace-write: Outside Is Blocked",
    desc: "Writing /etc/hosts escapes the workspace boundary, so the same mode refuses it.",
    mode: "workspace-write",
    op: "outside",
    allowed: false,
  },
  {
    title: "danger-full-access: No Boundary",
    desc: "With the sandbox off, the same /etc/hosts write runs with full user permissions.",
    mode: "danger-full-access",
    op: "outside",
    allowed: true,
  },
  {
    title: "The OS Holds the Line",
    desc: "Seatbelt (macOS) / Landlock (Linux) enforce the boundary in the kernel, so the model can't talk its way past it.",
    mode: "summary",
  },
];

function toneClass(tone: "blue" | "amber" | "red" | "emerald" | "zinc") {
  if (tone === "blue") return "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200";
  if (tone === "amber") return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200";
  if (tone === "red") return "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200";
  if (tone === "emerald") return "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200";
  return "border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
}

function Surface({
  title,
  icon,
  active,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border p-4 transition-colors",
        active
          ? "border-sky-300 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/30"
          : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
      )}
    >
      <div className="mb-4 flex items-center gap-3 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            active
              ? "bg-sky-500 text-white"
              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300"
          )}
        >
          {icon}
        </span>
        {title}
      </div>
      {children}
    </div>
  );
}

function OperationCard({ op }: { op: OpId }) {
  const operation = OPERATIONS[op];
  const Icon = operation.icon;
  return (
    <motion.div
      key={op}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          <Icon size={16} />
          tool call
        </div>
        <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-1 font-mono text-xs font-semibold dark:bg-zinc-800">
          {operation.tool}
        </span>
      </div>
      <code className="block min-w-0 rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100 whitespace-pre-wrap break-words">
        {operation.command}
      </code>
      <div className="mt-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        {operation.where}
      </div>
    </motion.div>
  );
}

function ModeCard({
  mode,
  active,
  muted,
}: {
  mode: (typeof MODES)[number];
  active: boolean;
  muted: boolean;
}) {
  const Icon = mode.icon;
  return (
    <motion.div
      layout
      animate={active ? { y: -1 } : { y: 0 }}
      className={cn(
        "min-w-0 rounded-xl border p-3",
        active ? toneClass(mode.tone) : "border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200",
        muted && "opacity-45"
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 font-mono text-sm font-semibold">
          <Icon size={15} />
          <span className="truncate">{mode.id}</span>
        </div>
        {active && <HardDrive size={15} className="shrink-0" />}
      </div>
      <div className="text-xs leading-relaxed opacity-80">{mode.writeScope}</div>
      <div className="mt-1 flex items-center gap-1 text-[11px] opacity-70">
        <Globe size={11} />
        {mode.network}
      </div>
    </motion.div>
  );
}

function Outcome({
  mode,
  op,
  allowed,
}: {
  mode: (typeof STEPS)[number]["mode"];
  op?: OpId;
  allowed?: boolean;
}) {
  if (mode === "overview") {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        pick a sandbox_mode to see the verdict
      </div>
    );
  }

  if (mode === "summary") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn("space-y-3 rounded-xl border p-4", toneClass("blue"))}
      >
        <div className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck size={17} />
          Enforced by the kernel
        </div>
        <div className="text-sm leading-relaxed">
          The boundary lives in Seatbelt on macOS and Landlock on Linux. It holds even if the model is
          compromised, because the check is below the process, not inside it.
        </div>
      </motion.div>
    );
  }

  const operation = OPERATIONS[op ?? "inside"];
  return (
    <motion.div
      key={`${mode}-${op}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("space-y-3 rounded-xl border p-4", toneClass(allowed ? "emerald" : "red"))}
    >
      <div className="flex items-center gap-2 text-base font-semibold">
        {allowed ? <ShieldCheck size={17} /> : <ShieldX size={17} />}
        {allowed ? "Allowed by sandbox" : "Denied by sandbox"}
      </div>
      <div className="rounded-lg bg-white/70 p-2 dark:bg-zinc-950/30">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-70">sandbox_mode</div>
        <code className="block font-mono text-xs leading-relaxed">{mode}</code>
      </div>
      <div className="rounded-lg bg-white/70 p-2 dark:bg-zinc-950/30">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-70">target</div>
        <code className="block font-mono text-xs leading-relaxed break-words">{operation.command}</code>
      </div>
      <div className="flex items-center gap-2 text-sm leading-relaxed">
        {allowed ? <PlayCircle size={15} /> : <OctagonAlert size={15} />}
        {allowed
          ? "The write stays inside the boundary, so the command runs."
          : "The write crosses the boundary, so the OS refuses it before it runs."}
      </div>
    </motion.div>
  );
}

export default function SandboxVisualization({ title }: { title?: string }) {
  const vis = useSteppedVisualization({ totalSteps: STEPS.length, autoPlayInterval: 2600 });
  const step = vis.currentStep;
  const current = STEPS[step];
  const mode = current.mode;
  const isOverview = mode === "overview" || mode === "summary";

  return (
    <section className="min-h-[500px] space-y-4">
      <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {title || "Sandbox Policy"}
      </h2>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-relaxed text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
          Approval asks the user; the sandbox asks the OS. A command runs only when{" "}
          <span className="font-mono">sandbox_mode</span> lets it touch what it wants to touch.
        </div>

        <div className="grid gap-3 lg:grid-cols-[1fr_1.05fr_1fr]">
          <Surface title="Tool call" icon={<Terminal size={20} />} active={!isOverview}>
            {current.op ? (
              <OperationCard op={current.op} />
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                a write command the agent wants to run
              </div>
            )}
          </Surface>

          <Surface title="Sandbox policy" icon={<HardDrive size={20} />} active={mode !== "overview"}>
            <div className="space-y-2">
              {MODES.map((m) => (
                <ModeCard
                  key={m.id}
                  mode={m}
                  active={mode === m.id}
                  muted={!isOverview && mode !== m.id}
                />
              ))}
              {isOverview && (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300">
                  The same command is judged by whichever mode is active — the loop above never changes.
                </div>
              )}
            </div>
          </Surface>

          <Surface title="Outcome" icon={<ShieldCheck size={20} />} active={!isOverview}>
            <AnimatePresence mode="wait">
              <Outcome key={`${mode}-${current.op}`} mode={mode} op={current.op} allowed={current.allowed} />
            </AnimatePresence>
          </Surface>
        </div>

        <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm leading-relaxed text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300">
          Beginner rule: the sandbox is a boundary the OS enforces, not a suggestion the model honors.
          read-only freezes writes, workspace-write confines them, danger-full-access removes the walls.
        </div>

        <StepControls
          className="mt-4"
          currentStep={vis.currentStep}
          totalSteps={vis.totalSteps}
          onPrev={vis.prev}
          onNext={vis.next}
          onReset={vis.reset}
          isPlaying={vis.isPlaying}
          onToggleAutoPlay={vis.toggleAutoPlay}
          stepTitle={current.title}
          stepDescription={current.desc}
        />
      </div>
    </section>
  );
}
