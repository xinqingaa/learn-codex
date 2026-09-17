"use client";

import { FolderGit2 } from "lucide-react";
import { StepControls } from "@/components/visualizations/shared/step-controls";
import { useSteppedVisualization } from "@/hooks/useSteppedVisualization";
import { cn } from "@/lib/utils";

type LaneState = "empty" | "active" | "merged" | "kept";

const STEPS = [
  {
    title: "Root Opens Two Checkouts",
    desc: "Like two App Worktree chats. Not s17 claiming, not a Cloud container. Named branches are a teaching extra — App default is detached HEAD.",
  },
  {
    title: "Same Path, Two Directories",
    desc: "alice writes wt-t1/app.txt; bob writes wt-t2/app.txt. They share one .git and never clobber each other.",
  },
  {
    title: "Teaching Merge: t1 Lands Clean",
    desc: "Codex does not auto-merge into main. The chapter merges so the deferred conflict is visible. wt/t1 is first and lands.",
  },
  {
    title: "t2 Conflicts — Keep the Branch",
    desc: "Both edited app.txt. git refuses, merge --abort, wt-t2 stays for a human. App exit is keep / Create branch / PR, not this merge.",
  },
];

function lanesAt(step: number): { name: string; file: string; state: LaneState; note: string }[] {
  return [
    {
      name: "repo/main",
      file: step >= 2 ? 'app.txt = "base" + alice' : 'app.txt = "base"',
      state: step >= 2 ? "merged" : "empty",
      note: step >= 2 ? "wt/t1 merged" : "shared .git",
    },
    {
      name: "wt-t1/ · wt/t1",
      file: step >= 1 ? "app.txt = base + alice" : '(checkout of "base")',
      state: step >= 2 ? "merged" : "active",
      note: step >= 2 ? "removed after clean merge" : step >= 1 ? "alice wrote here" : "alice's session",
    },
    {
      name: "wt-t2/ · wt/t2",
      file: step >= 1 ? "app.txt = base + bob" : '(checkout of "base")',
      state: step >= 3 ? "kept" : "active",
      note: step >= 3 ? "CONFLICT · kept for review" : step >= 1 ? "bob wrote here" : "bob's session",
    },
  ];
}

function laneClass(state: LaneState): string {
  if (state === "active") return "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30";
  if (state === "merged") return "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30";
  if (state === "kept") return "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30";
  return "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900";
}

export default function WorktreeTaskIsolation({ title }: { title?: string }) {
  const vis = useSteppedVisualization({ totalSteps: STEPS.length, autoPlayInterval: 2600 });
  const step = vis.currentStep;
  const lanes = lanesAt(step);

  return (
    <section className="min-h-[500px] space-y-4">
      <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{title || "Disjoint Checkouts"}</h2>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300">
          Root opened wt-t1 and wt-t2, then started alice and bob. Same path, two contents. Cloud containers are s23.
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          {lanes.map((lane) => (
            <div key={lane.name} className={cn("rounded-lg border p-3", laneClass(lane.state))}>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                <FolderGit2 size={14} />
                {lane.name}
              </div>
              <div className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{lane.file}</div>
              <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{lane.note}</div>
            </div>
          ))}
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
