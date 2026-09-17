"use client";

import { Cable, Server } from "lucide-react";
import { StepControls } from "@/components/visualizations/shared/step-controls";
import { useSteppedVisualization } from "@/hooks/useSteppedVisualization";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    title: "Config at Session Start",
    desc: "Codex reads [mcp_servers.docs] and [mcp_servers.deploy] before the loop. The model has no connect_mcp tool.",
  },
  {
    title: "Spawn and Handshake",
    desc: "Each child speaks newline-delimited JSON-RPC: initialize → tools/list. docs exposes search and get_page; deploy exposes trigger.",
  },
  {
    title: "Prefix for the Model",
    desc: "The registry gets mcp__docs__search, mcp__docs__get_page, mcp__deploy__trigger. tools/call still uses the raw name.",
  },
  {
    title: "Call Like Any Tool",
    desc: "The loop is unchanged since s01. mcp__docs__search becomes tools/call { name: \"search\" } on the docs child.",
  },
];

const SERVERS = [
  { name: "docs", tools: ["search", "get_page"] },
  { name: "deploy", tools: ["trigger"] },
] as const;

const BRIDGED = [
  { label: "mcp__docs__search", raw: "search" },
  { label: "mcp__docs__get_page", raw: "get_page" },
  { label: "mcp__deploy__trigger", raw: "trigger" },
] as const;

export default function McpToolsVisualization({ title }: { title?: string }) {
  const vis = useSteppedVisualization({ totalSteps: STEPS.length, autoPlayInterval: 2600 });
  const step = vis.currentStep;
  const listed = step >= 1;
  const bridged = step >= 2;
  const called = step >= 3;

  return (
    <section className="min-h-[500px] space-y-4">
      <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {title || "MCP Tool Bridge"}
      </h2>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300">
          Spawn two stdio children from config, then open the loop. HTTP, OAuth, and Codex-as-a-server are other chapters.
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <div
            className={cn(
              "rounded-lg border p-3",
              step === 0
                ? "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30"
                : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
            )}
          >
            <div className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">config.toml</div>
            <div className="space-y-2 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
              <div>[mcp_servers.docs]</div>
              <div>[mcp_servers.deploy]</div>
              <div className="text-zinc-500 dark:text-zinc-400">command + args each</div>
            </div>
          </div>

          <div
            className={cn(
              "rounded-lg border p-3",
              step === 1
                ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30"
                : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
            )}
          >
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              <Server size={14} />
              stdio children
            </div>
            <div className="space-y-2">
              {SERVERS.map((server) => (
                <div
                  key={server.name}
                  className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-2 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  <div className="flex items-center justify-between font-mono text-[11px] text-zinc-700 dark:text-zinc-200">
                    <span className="flex items-center gap-1">
                      <Cable size={12} />
                      {server.name}
                    </span>
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                      {listed ? "tools/list" : "offline"}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                    {listed ? server.tools.join(" · ") : "waiting for initialize"}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            className={cn(
              "rounded-lg border p-3",
              step >= 2
                ? "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30"
                : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
            )}
          >
            <div className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">model-visible tools</div>
            {bridged ? (
              <div className="space-y-2">
                {BRIDGED.map((tool) => (
                  <div
                    key={tool.label}
                    className={cn(
                      "break-all rounded-md border px-2 py-1.5 font-mono text-[11px] leading-snug",
                      called && tool.label === "mcp__docs__search"
                        ? "border-blue-300 bg-white text-blue-800 dark:border-blue-800 dark:bg-zinc-900 dark:text-blue-200"
                        : "border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                    )}
                  >
                    {tool.label}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                empty until tools/list
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-[11px] leading-snug text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {called
            ? 'mcp__docs__search → tools/call { name: "search", arguments: { query: "agent loop" } }'
            : "waiting for a model call — agentLoop unchanged since s01"}
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
