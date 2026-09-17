"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ClipboardList, Swords } from "lucide-react";
import { StepControls } from "@/components/visualizations/shared/step-controls";
import { useSteppedVisualization } from "@/hooks/useSteppedVisualization";
import { cn } from "@/lib/utils";

type Phase = "idle" | "scanning" | "lost" | "claimed" | "working" | "done" | "shutdown";
type RowStatus = "pending" | "blocked" | "in_progress" | "done";

const STEPS = [
  {
    title: "Root Seeds, Does Not Assign",
    desc: "t1 and t2 are free; t3 is blocked. Codex would still spawn_agent / followup — this board is teaching.",
  },
  {
    title: "Both scan() t1 Unlocked",
    desc: "The read is a clue. Two workers can see the same pending row; that result is already stale.",
  },
  {
    title: "claim() Picks One Winner",
    desc: "The re-check runs inside the mutex. alice writes owner; bob gets race LOST.",
  },
  {
    title: "Loser Takes t2",
    desc: "bob does not retry t1. The board already has another unblocked row.",
  },
  {
    title: "t3 Opens After Deps",
    desc: "s12's blockedBy still holds. When t1 and t2 are done, t3 becomes claimable; then the board shuts down.",
  },
];

function alicePhase(step: number): Phase {
  if (step >= 4) return "shutdown";
  if (step >= 3) return "working";
  if (step >= 2) return "claimed";
  if (step >= 1) return "scanning";
  return "idle";
}

function bobPhase(step: number): Phase {
  if (step >= 4) return "shutdown";
  if (step >= 3) return "working";
  if (step >= 2) return "lost";
  if (step >= 1) return "scanning";
  return "idle";
}

function boardAt(step: number): { id: string; title: string; status: RowStatus; owner?: string }[] {
  return [
    {
      id: "t1",
      title: "Design the DB schema",
      status: step >= 4 ? "done" : step >= 2 ? "in_progress" : "pending",
      owner: step >= 2 ? "alice" : undefined,
    },
    {
      id: "t2",
      title: "Write the API routes",
      status: step >= 4 ? "done" : step >= 3 ? "in_progress" : "pending",
      owner: step >= 3 ? "bob" : undefined,
    },
    {
      id: "t3",
      title: "Write the tests",
      status: step >= 4 ? "done" : "blocked",
      owner: step >= 4 ? "bob" : undefined,
    },
  ];
}

function phaseClass(phase: Phase): string {
  if (phase === "working" || phase === "done" || phase === "claimed")
    return "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30";
  if (phase === "scanning" || phase === "lost")
    return "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30";
  return "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900";
}

function statusClass(status: RowStatus): string {
  if (status === "done") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
  if (status === "in_progress") return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
  if (status === "blocked") return "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
  return "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200";
}

function WorkerCard({ name, phase, note }: { name: string; phase: Phase; note: string }) {
  return (
    <motion.div layout className={cn("rounded-lg border p-3 transition-colors", phaseClass(phase))}>
      <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{name}</div>
      <div className="mt-1 font-mono text-[11px] capitalize text-zinc-500 dark:text-zinc-400">{phase}</div>
      <div className="mt-2 break-words text-xs text-zinc-600 dark:text-zinc-300">{note}</div>
    </motion.div>
  );
}

export default function AutonomousAgents({ title }: { title?: string }) {
  const vis = useSteppedVisualization({ totalSteps: STEPS.length, autoPlayInterval: 2600 });
  const step = vis.currentStep;
  const alice = alicePhase(step);
  const bob = bobPhase(step);
  const rows = boardAt(step);

  return (
    <section className="min-h-[500px] space-y-4">
      <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{title || "Claim Race"}</h2>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300">
          Root seeded the board and stopped assigning. Either worker can win t1; this trace shows alice winning so the race is visible.
        </div>

        <div className="grid gap-3 lg:grid-cols-[1fr_1.3fr]">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              <Swords size={15} />
              Two loops, one lock
            </div>
            <WorkerCard
              name="alice"
              phase={alice}
              note={
                alice === "idle"
                  ? "online — polling"
                  : alice === "scanning"
                    ? "scan() → t1 (unlocked)"
                    : alice === "claimed" || alice === "working"
                      ? "claimed t1 inside the mutex"
                      : "board settled — shutdown"
              }
            />
            <WorkerCard
              name="bob"
              phase={bob}
              note={
                bob === "idle"
                  ? "online — polling"
                  : bob === "scanning"
                    ? "scan() → t1 (unlocked)"
                    : bob === "lost"
                      ? "race LOST on t1 — re-scan"
                      : bob === "working"
                        ? "claimed t2 instead"
                        : "claimed t3 after deps — shutdown"
              }
            />
          </div>

          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/70">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              <ClipboardList size={15} />
              s12 TaskBoard (teaching)
            </div>
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {rows.map((row) => (
                  <motion.div
                    layout
                    key={`${row.id}-${row.status}-${row.owner ?? "-"}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-zinc-600 dark:text-zinc-300">{row.id}</span>
                      <span className={cn("rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold", statusClass(row.status))}>
                        {row.status}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-800 dark:text-zinc-100">{row.title}</div>
                    <div className="mt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      owner: {row.owner ?? "—"}
                      {row.id === "t3" && step < 4 ? "  ·  blockedBy t1+t2" : ""}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
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
          stepTitle={STEPS[step].title}
          stepDescription={STEPS[step].desc}
        />
      </div>
    </section>
  );
}
