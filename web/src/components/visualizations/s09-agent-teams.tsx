"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Inbox, MessageSquareText, UsersRound } from "lucide-react";
import { StepControls } from "@/components/visualizations/shared/step-controls";
import { useSteppedVisualization } from "@/hooks/useSteppedVisualization";
import { cn } from "@/lib/utils";

type AgentId = "root" | "researcher" | "writer";

interface Mail {
  id: string;
  from: AgentId;
  to: AgentId;
  subject: string;
  body: string;
  appearsAt: number;
  consumedAt?: number;
}

const AGENTS: { id: AgentId; label: string; role: string }[] = [
  { id: "root", label: "root", role: "spawns children, wait_agent for finals" },
  { id: "researcher", label: "researcher", role: "own context · send_message findings" },
  { id: "writer", label: "writer", role: "own context · wait_agent then write" },
];

const MAIL: Mail[] = [
  {
    id: "spawn-r",
    from: "root",
    to: "researcher",
    subject: "spawn_agent",
    body: "Research the agent loop; send_message findings to writer.",
    appearsAt: 1,
    consumedAt: 3,
  },
  {
    id: "spawn-w",
    from: "root",
    to: "writer",
    subject: "spawn_agent",
    body: "wait_agent for findings, then write agent-loop.md.",
    appearsAt: 1,
    consumedAt: 4,
  },
  {
    id: "findings",
    from: "researcher",
    to: "writer",
    subject: "send_message",
    body: "Findings: loop = run tools until none remain.",
    appearsAt: 3,
    consumedAt: 4,
  },
  {
    id: "final-r",
    from: "researcher",
    to: "root",
    subject: "final",
    body: "Findings queued for writer.",
    appearsAt: 5,
  },
  {
    id: "final-w",
    from: "writer",
    to: "root",
    subject: "final",
    body: "Doc saved: agent-loop.md",
    appearsAt: 5,
  },
];

const STEPS = [
  {
    title: "Root Owns the User Thread",
    desc: "The user talks to root. Children are not started yet — each will get its own context window.",
  },
  {
    title: "spawn_agent Returns Immediately",
    desc: "Unlike s06's spawnSubagent, which waits for one conclusion, both children start without the parent awaiting them.",
  },
  {
    title: "Researcher Works Alone",
    desc: "gather_notes stays in the researcher's private input. Root never sees the raw notes.",
  },
  {
    title: "send_message Queues, Does Not Start a Turn",
    desc: "Findings land in the writer's in-process mailbox. If writer is blocked on wait_agent, the mail is handed over now.",
  },
  {
    title: "Writer wait_agent Then Writes",
    desc: "Writer's window holds the one-line conclusion, not the research notes, then writes agent-loop.md.",
  },
  {
    title: "Harness Posts final to Parent",
    desc: "When a child loop ends, Codex-style FINAL_ANSWER is posted to root's mailbox. Root wait_agent collects both.",
  },
  {
    title: "Windows Never Merge",
    desc: "The team shared information through the mailbox. Three contexts stayed small; the artifact is on disk.",
  },
] as const;

function visibleMail(agent: AgentId, step: number) {
  return MAIL.filter((mail) => mail.to === agent && mail.appearsAt <= step && (mail.consumedAt === undefined || step < mail.consumedAt));
}

function agentState(agent: AgentId, step: number): "waiting" | "spawning" | "working" | "waiting-mail" | "done" {
  if (step === 6) return "done";
  if (agent === "root" && step === 1) return "spawning";
  if (agent === "root" && step >= 5) return "waiting-mail";
  if (agent === "researcher" && (step === 2 || step === 3)) return "working";
  if (agent === "writer" && step === 3) return "waiting-mail";
  if (agent === "writer" && step === 4) return "working";
  return "waiting";
}

function stateClass(state: ReturnType<typeof agentState>) {
  if (state === "working" || state === "spawning") return "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30";
  if (state === "waiting-mail") return "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30";
  if (state === "done") return "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30";
  return "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900";
}

function MailCard({ mail }: { mail: Mail }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.22 }}
      className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900 shadow-sm dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold">{mail.from} -&gt; {mail.to}</span>
        <MessageSquareText size={14} />
      </div>
      <div className="text-sm font-semibold leading-snug">{mail.subject}</div>
      <div className="mt-1 text-xs leading-relaxed opacity-85">{mail.body}</div>
    </motion.div>
  );
}

function AgentPanel({ agent, step }: { agent: (typeof AGENTS)[number]; step: number }) {
  const state = agentState(agent.id, step);
  const inbox = visibleMail(agent.id, step);

  return (
    <div className={cn("rounded-lg border p-3 transition-colors", stateClass(state))}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="text-base font-bold text-zinc-900 dark:text-zinc-100">{agent.label}</div>
          <div className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{agent.role}</div>
        </div>
        <span className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold capitalize text-zinc-600 shadow-sm dark:bg-zinc-900 dark:text-zinc-300">
          {state}
        </span>
      </div>

      <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          <Inbox size={15} />
          mailbox:{agent.id}
        </div>
        <div className="min-h-[118px] space-y-2">
          <AnimatePresence mode="popLayout">
            {inbox.length > 0 ? (
              inbox.map((mail) => <MailCard key={mail.id} mail={mail} />)
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-md border border-dashed border-zinc-300 px-3 py-8 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
              >
                inbox empty
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function ActivityLog({ step }: { step: number }) {
  const items = [
    "user talks to root only",
    "root spawn_agent researcher + writer (non-blocking)",
    "researcher gather_notes in its own context",
    "send_message queues findings on writer's mailbox",
    "writer wait_agent delivers, then write_file",
    "harness posts final to root for each child",
    "three windows never merged — artifact is on disk",
  ].slice(0, step + 1);

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/70">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
        <UsersRound size={16} />
        What changed
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <motion.div
            key={item}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          >
            {item}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

export default function AgentTeams({ title }: { title?: string }) {
  const vis = useSteppedVisualization({ totalSteps: STEPS.length, autoPlayInterval: 2500 });
  const step = vis.currentStep;
  const current = STEPS[step];

  return (
    <section className="min-h-[500px] space-y-4">
      <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {title || "Agent Team Mailboxes"}
      </h2>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="grid gap-3 xl:grid-cols-[1fr_1fr_1fr_0.9fr]">
          {AGENTS.map((agent) => (
            <AgentPanel key={agent.id} agent={agent} step={step} />
          ))}
          <ActivityLog step={step} />
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
