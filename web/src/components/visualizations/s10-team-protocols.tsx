"use client";

import { type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Inbox, ListChecks, Radio } from "lucide-react";
import { StepControls } from "@/components/visualizations/shared/step-controls";
import { useSteppedVisualization } from "@/hooks/useSteppedVisualization";
import { cn } from "@/lib/utils";

type RowStatus = "empty" | "pending" | "ignored" | "fulfilled";

const STEPS = [
  {
    title: "Envelope Is the Contract",
    desc: "s15 mail was a sentence. The envelope adds kind, id, triggerTurn — and teaching replyTo.",
  },
  {
    title: "Broadcast Needs No Reply",
    desc: "Kickoff fans out to every registered mailbox. Codex has no broadcast kind; this is a teaching extra.",
  },
  {
    title: "Three Requests, One Ledger",
    desc: "Root records req_002 / req_003 / req_004 before any reply arrives. request ≈ NEW_TASK (triggerTurn).",
  },
  {
    title: "Unknown replyTo Is Dropped",
    desc: "A ghost with replyTo req_999 is not on the ledger, so collect ignores it.",
  },
  {
    title: "Match by replyTo, Then Stand Down",
    desc: "Harness-posted responses tick the matching row. Stand-down is another no-reply broadcast.",
  },
];

const LEDGER: { id: string; to: string; task: string; at: number; ghost?: boolean }[] = [
  { id: "req_002", to: "alice", task: "agent loop overview", at: 2 },
  { id: "req_003", to: "bob", task: "tool use section", at: 2 },
  { id: "req_004", to: "alice", task: "approval policy", at: 2 },
  { id: "req_999", to: "bob", task: "ghost: no such request", at: 3, ghost: true },
];

function statusFor(row: (typeof LEDGER)[number], step: number): RowStatus {
  if (step < row.at) return "empty";
  if (row.ghost) return step >= 3 ? "ignored" : "empty";
  if (step >= 4) return "fulfilled";
  return "pending";
}

function EnvelopeCard({ title, rows, tone }: { title: string; rows: string[]; tone: "purple" | "blue" | "green" | "amber" }) {
  const toneClass = {
    purple: "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200",
    blue: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200",
    green: "border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100",
    amber: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  }[tone];
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className={cn("rounded-md border p-3 shadow-sm", toneClass)}
    >
      <div className="break-words font-mono text-xs font-semibold">{title}</div>
      <div className="mt-2 space-y-1 font-mono text-[11px] opacity-85">
        {rows.map((row) => (
          <div key={row} className="break-words">
            {row}
          </div>
        ))}
      </div>
    </motion.div>
  );
}

function AgentDesk({
  name,
  role,
  active,
  children,
}: {
  name: string;
  role: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-h-[220px] rounded-lg border p-3 transition-colors",
        active
          ? "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30"
          : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
      )}
    >
      <div className="mb-1 text-sm font-semibold text-zinc-800 dark:text-zinc-100">{name}</div>
      <div className="mb-3 break-words text-[11px] text-zinc-500 dark:text-zinc-400">{role}</div>
      {children}
    </div>
  );
}

export default function TeamProtocols({ title }: { title?: string }) {
  const vis = useSteppedVisualization({ totalSteps: STEPS.length, autoPlayInterval: 2600 });
  const step = vis.currentStep;

  return (
    <section className="min-h-[500px] space-y-4">
      <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {title || "Request Ledger"}
      </h2>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/70">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            <ListChecks size={15} />
            Root pending ledger
          </div>
          <div className="space-y-2">
            {LEDGER.map((row) => {
              const status = statusFor(row, step);
              if (status === "empty") return null;
              return (
                <div
                  key={row.id}
                  className={cn(
                    "rounded-md border px-3 py-2 font-mono text-[11px]",
                    status === "fulfilled" &&
                      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200",
                    status === "pending" &&
                      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200",
                    status === "ignored" &&
                      "border-zinc-200 bg-zinc-100 text-zinc-500 line-through dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-500"
                  )}
                >
                  <span className="font-semibold">{row.id}</span>
                  {"  "}
                  {row.to}: {row.task}
                  {"  "}
                  {status}
                </div>
              );
            })}
            {step < 2 && (
              <div className="rounded-md border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                no in-flight requests
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <AgentDesk name="root" role="records ids · collect by replyTo" active={step === 2 || step === 4}>
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {step >= 1 && (
                  <EnvelopeCard
                    key="bcast"
                    title="broadcast"
                    rows={["to: *", "triggerTurn: false", step >= 4 ? "stand down" : "kickoff"]}
                    tone="blue"
                  />
                )}
                {step >= 2 && (
                  <EnvelopeCard
                    key="reqs"
                    title="request × 3"
                    rows={["req_002 → alice", "req_003 → bob", "req_004 → alice", "triggerTurn: true"]}
                    tone="purple"
                  />
                )}
              </AnimatePresence>
              {step === 0 && (
                <div className="rounded-md border border-dashed border-zinc-300 px-3 py-5 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  waiting to route envelopes
                </div>
              )}
            </div>
          </AgentDesk>

          <AgentDesk name="Mailbox" role="in-process waiters · not a file" active={step === 0 || step === 3}>
            <div className="mb-3 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
              <Inbox size={14} />
              same s15 channel, typed payload
            </div>
            <EnvelopeCard
              title="Envelope"
              rows={["id, from, to, kind", "payload", "replyTo?  (teaching)", "triggerTurn"]}
              tone="purple"
            />
            {step >= 3 && (
              <div className="mt-2">
                <EnvelopeCard
                  title="response replyTo=req_999"
                  rows={["unknown id", "collect: ignore"]}
                  tone="amber"
                />
              </div>
            )}
          </AgentDesk>

          <AgentDesk name="alice / bob" role="dispatch by kind · harness posts FINAL_ANSWER" active={step === 1 || step === 4}>
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {step >= 1 && (
                  <div
                    key="heard"
                    className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
                  >
                    <Radio size={14} />
                    heard broadcast — no reply
                  </div>
                )}
                {step >= 4 && (
                  <EnvelopeCard
                    key="finals"
                    title="response × 3"
                    rows={["replyTo: req_002", "replyTo: req_003", "replyTo: req_004"]}
                    tone="green"
                  />
                )}
              </AnimatePresence>
              {step < 1 && (
                <div className="rounded-md border border-dashed border-zinc-300 px-3 py-5 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  online — waiting for envelopes
                </div>
              )}
            </div>
          </AgentDesk>
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
