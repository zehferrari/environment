import { db } from "@/lib/db";

const FAILURE_LIMIT = 5;
const PROBE_INTERVAL_MS = 10 * 60_000;
const CRITICAL_REASONS = new Set([
  "review_requested", "review_feedback", "todo_start_required", "blocker_response",
  "action_plan_review_requested", "action_plan_feedback_received", "checkpoint_published",
  "owner_instruction",
]);

/** A reachable agent's empty reply/contract error is not a dead gateway. */
export function isPmTransportFailure(run: { status: string; error: string | null; finishedReason: string | null }) {
  if (run.status !== "failed" && run.status !== "timed_out") return false;
  if (run.finishedReason === "turn_failure_exhausted" || run.finishedReason === "no_reply") return false;
  return /fetch failed|ECONN(?:REFUSED|RESET)|ENOTFOUND|EHOSTUNREACH|socket hang up|gateway.*(?:unavailable|unreachable|connection|HTTP 5)|(?:dispatch|claimed).*lease expired|HTTP 50[234]/i
    .test(`${run.error ?? ""} ${run.finishedReason ?? ""}`);
}

/** Durable compare-and-set: one probe across concurrent requests/processes.
 * This single coordination row stores the last claim; suppression has its own
 * append-only activity records. A crash cannot release a probe early. */
export async function claimDispatchProbe(args: { agentSlug: string; now: Date; projectId?: string | null }) {
  const dedupeKey = `pm-channel-probe:${args.agentSlug}`;
  return db.$transaction(async tx => {
    const existing = await tx.activityLog.findUnique({ where: { dedupeKey }, select: { id: true, createdAt: true } });
    if (existing) {
      if (args.now.getTime() - existing.createdAt.getTime() < PROBE_INTERVAL_MS) return false;
      const claimed = await tx.activityLog.updateMany({
        where: { id: existing.id, createdAt: existing.createdAt },
        data: { createdAt: args.now, payload: JSON.stringify({ probeIntervalMs: PROBE_INTERVAL_MS, lastClaimedAt: args.now.toISOString() }) },
      });
      return claimed.count === 1;
    }
    await tx.activityLog.create({ data: {
      kind: "pm.channel.probe_lease", dedupeKey, targetAgent: args.agentSlug,
      projectId: args.projectId ?? null, createdAt: args.now,
      payload: JSON.stringify({ probeIntervalMs: PROBE_INTERVAL_MS, lastClaimedAt: args.now.toISOString() }),
    } });
    return true;
  });
}

export async function channelDispatchAdmission(args: {
  agentSlug: string; workflowReason?: string; projectId?: string | null; now?: Date;
}): Promise<{ open: boolean; failures: number; probeIntervalMs: number }> {
  const now = args.now ?? new Date();
  const recent = await db.pmChannelRun.findMany({
    where: { agentSlug: args.agentSlug, status: { in: ["failed", "completed", "timed_out"] } },
    orderBy: { updatedAt: "desc" }, take: 40,
    select: { status: true, error: true, finishedReason: true, updatedAt: true },
  });
  // Ignore semantic failures for transport health. The task watchdog and its
  // bounded recovery budget remain responsible for an agent making no progress.
  const health = recent.filter(run => run.status === "completed" || isPmTransportFailure(run)).slice(0, FAILURE_LIMIT);
  const failed = health.length === FAILURE_LIMIT && health.every(isPmTransportFailure);
  const result = { failures: failed ? FAILURE_LIMIT : 0, probeIntervalMs: PROBE_INTERVAL_MS };
  if (!failed) return { ...result, open: false };
  const critical = CRITICAL_REASONS.has(args.workflowReason ?? "");
  if (!critical && now.getTime() - health[0].updatedAt.getTime() < PROBE_INTERVAL_MS) return { ...result, open: true };
  return { ...result, open: !await claimDispatchProbe({ ...args, now }) };
}
