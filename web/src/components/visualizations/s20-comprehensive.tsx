"use client";

import { ShieldCheck, Wrench } from "lucide-react";
import { StepControls } from "@/components/visualizations/shared/step-controls";
import { useSteppedVisualization } from "@/hooks/useSteppedVisualization";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    title: "Three Seams, One Loop",
    desc: "Part I capstone. Register MCP before the loop. Skills, teams, and worktrees still hang on these seams — they are not restacked here.",
  },
  {
    title: "A Registry Tool, Then Approval Says No",
    desc: "update_plan is just another function tool. git push --force hits withApproval; the demo auto-answers no. The loop does not stop.",
  },
  {
    title: "Sandbox Says No, Then Yes",
    desc: "write_file /etc is outside the temp workspace. notes.md is inside. Real Codex sandboxes every exec; this file path-checks write_file.",
  },
  {
    title: "MCP and a Child Loop",
    desc: "mcp__docs__search was registered at session start (in-process mock; stdio is s19). spawn_subagent is s06's fresh context, not s15's mailbox.",
  },
];

const LAYERS = [
  { id: "memory", label: "memory · rollout.jsonl (s09)", detail: "wraps the model call" },
  { id: "loop", label: "s01 agent loop", detail: "model → function_call? → dispatch → feed back" },
  { id: "sandbox", label: "sandbox (s04)", detail: "workspace-write path check" },
  { id: "approval", label: "approval (s03)", detail: "on-request · demo answers no" },
  { id: "registry", label: "registry (s02)", detail: "dispatch by name" },
] as const;

const TOOLS = [
  { name: "update_plan", beat: 1 },
  { name: "shell", beat: 1 },
  { name: "write_file", beat: 2 },
  { name: "mcp__docs__search", beat: 3 },
  { name: "spawn_subagent", beat: 3 },
] as const;

function layerActive(id: string, step: number): boolean {
  if (step === 0) return id === "loop" || id === "memory";
  if (step === 1) return id === "approval" || id === "registry";
  if (step === 2) return id === "sandbox" || id === "registry";
  return id === "registry" || id === "memory";
}

export default function ComprehensiveVisualization({ title }: { title?: string }) {
  const vis = useSteppedVisualization({ totalSteps: STEPS.length, autoPlayInterval: 2800 });
  const step = vis.currentStep;
  const current = STEPS[step];

  return (
    <section className="min-h-[500px] space-y-4">
      <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {title || "Three Seams, One Loop"}
      </h2>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300">
          Representatives only. No connect_mcp, no spawn_teammate, no worktree tool. Part II starts at s21.
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-2">
            {LAYERS.map((layer) => (
              <div
                key={layer.id}
                className={cn(
                  "rounded-lg border px-3 py-2",
                  layerActive(layer.id, step)
                    ? "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30"
                    : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
                )}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                  {layer.id === "sandbox" || layer.id === "approval" ? (
                    <ShieldCheck size={14} />
                  ) : (
                    <Wrench size={14} />
                  )}
                  {layer.label}
                </div>
                <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{layer.detail}</div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/70">
            <div className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">model-visible tools</div>
            <div className="space-y-2">
              {TOOLS.map((tool) => (
                <div
                  key={tool.name}
                  className={cn(
                    "break-all rounded-md border px-2 py-1.5 font-mono text-[11px] leading-snug",
                    step >= tool.beat
                      ? "border-blue-300 bg-white text-blue-800 dark:border-blue-800 dark:bg-zinc-900 dark:text-blue-200"
                      : "border-zinc-200 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                  )}
                >
                  {tool.name}
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-md border border-zinc-200 bg-white p-2 font-mono text-[11px] leading-snug text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              {step === 0 && "registerMcp(\"docs\") then open agentLoop"}
              {step === 1 && "⚙ shell git push --force → [approval] denied"}
              {step === 2 && "⚙ write_file /etc → [sandbox] denied; notes.md allowed"}
              {step === 3 && "⚙ mcp__docs__search · spawn_subagent → child summary"}
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
          stepTitle={current.title}
          stepDescription={current.desc}
        />
      </div>
    </section>
  );
}
