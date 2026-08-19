import { db } from "@/lib/db";

/**
 * ENV-159: Durable per-agent execution lane.
 *
 * Ensures only one run per agent is reserved/admitted/running at a time.
 * The partial unique index on (agentSlug) WHERE status IN (reserved, admitted,
 * running) is the constraint that makes the lane exclusive.
 *
 * Queue priority is enforced by the job scheduler:
 *   continuation > review feedback > reviewer/manager decisions >
 *   newly approved To Do > informational
 */

export type LaneStatus = "reserved" | "admitted" | "running" | "released";

export type LanePriority =
  | "continuation"
  | "review_feedback"
  | "reviewer_decision"
  | "manager_decision"
  | "newly_approved"
  | "informational";

export const PRIORITY_ORDER: Record<LanePriority, number> = {
  continuation: 0,
  review_feedback: 1,
  reviewer_decision: 2,
  manager_decision: 3,
  newly_approved: 4,
  informational: 5,
};

export interface ExecutionLane {
  id: string;
  agentSlug: string;
  runId: string | null;
  taskId: string | null;
  status: LaneStatus;
  leaseToken: string;
  acquiredAt: Date;
  heartbeatAt: Date | null;
  expiresAt: Date | null;
  releasedAt: Date | null;
}

const LANE_LEASE_MS = Number.parseInt(
  process.env.PM_EXECUTION_LANE_LEASE_MS ?? "300000",
  10,
);

/**
 * Reserve the execution lane for an agent. If the lane is already occupied
 * (an active lease exists), returns { acquired: false, blockedByRunId }.
 * The caller should then mark the run as waiting_capacity.
 */
export async function reserveExecutionLane(args: {
  agentSlug: string;
  runId: string;
  taskId?: string | null;
}): Promise<{ acquired: true; lane: ExecutionLane } | { acquired: false; blockedByRunId: string; blockedByTaskId: string | null }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LANE_LEASE_MS);

  // Check for an existing active lease
  const existing = await db.agentExecutionLease.findFirst({
    where: {
      agentSlug: args.agentSlug,
      status: { in: ["reserved", "admitted", "running"] },
    },
    select: { id: true, runId: true, taskId: true, expiresAt: true },
  });

  // Expire stale leases
  if (existing && existing.expiresAt && existing.expiresAt < now) {
    await db.agentExecutionLease.update({
      where: { id: existing.id },
      data: { status: "released", releasedAt: now },
    });
  } else if (existing) {
    return {
      acquired: false,
      blockedByRunId: existing.runId ?? "",
      blockedByTaskId: existing.taskId,
    };
  }

  try {
    const lane = await db.agentExecutionLease.create({
      data: {
        agentSlug: args.agentSlug,
        runId: args.runId,
        taskId: args.taskId ?? null,
        status: "reserved",
        leaseToken: crypto.randomUUID(),
        acquiredAt: now,
        expiresAt,
      },
    });
    return {
      acquired: true,
      lane: {
        id: lane.id,
        agentSlug: lane.agentSlug,
        runId: lane.runId,
        taskId: lane.taskId,
        status: lane.status as LaneStatus,
        leaseToken: lane.leaseToken,
        acquiredAt: lane.acquiredAt,
        heartbeatAt: lane.heartbeatAt,
        expiresAt: lane.expiresAt,
        releasedAt: lane.releasedAt,
      },
    };
  } catch (err) {
    // The partial unique index rejected the insert — another lease was created
    // concurrently. Re-read to find the holder.
    const holder = await db.agentExecutionLease.findFirst({
      where: {
        agentSlug: args.agentSlug,
        status: { in: ["reserved", "admitted", "running"] },
      },
      select: { runId: true, taskId: true },
    });
    return {
      acquired: false,
      blockedByRunId: holder?.runId ?? "",
      blockedByTaskId: holder?.taskId ?? null,
    };
  }
}

/**
 * Transition a reserved lane to admitted (model execution admitted).
 */
export async function admitExecutionLane(args: {
  runId: string;
  leaseToken: string;
}): Promise<boolean> {
  try {
    const updated = await db.agentExecutionLease.updateMany({
      where: { runId: args.runId, leaseToken: args.leaseToken, status: "reserved" },
      data: { status: "admitted" },
    });
    return updated.count > 0;
  } catch {
    return false;
  }
}

/**
 * Transition a lane to running (first model/progress callback received).
 */
export async function activateExecutionLane(args: {
  runId: string;
  leaseToken: string;
}): Promise<boolean> {
  try {
    const updated = await db.agentExecutionLease.updateMany({
      where: { runId: args.runId, leaseToken: args.leaseToken, status: { in: ["reserved", "admitted"] } },
      data: { status: "running", heartbeatAt: new Date() },
    });
    return updated.count > 0;
  } catch {
    return false;
  }
}

/**
 * Release the execution lane on terminal callback, supersession, explicit
 * cancellation, or confirmed timeout. After release, durably schedules the
 * next eligible job.
 */
export async function releaseExecutionLane(args: {
  runId: string;
}): Promise<{ released: boolean; nextRunId: string | null }> {
  const now = new Date();
  try {
    const lane = await db.agentExecutionLease.findUnique({
      where: { runId: args.runId },
      select: { id: true, agentSlug: true, status: true },
    });
    if (!lane || lane.status === "released") {
      return { released: false, nextRunId: null };
    }
    await db.agentExecutionLease.update({
      where: { id: lane.id },
      data: { status: "released", releasedAt: now },
    });

    // Find the next eligible waiting_capacity job for this agent
    const next = await db.pmChannelRun.findFirst({
      where: {
        agentSlug: lane.agentSlug,
        status: "waiting_capacity",
      },
      orderBy: { capacityBlockedAt: "asc" },
      select: { id: true },
    });

    return { released: true, nextRunId: next?.id ?? null };
  } catch {
    return { released: false, nextRunId: null };
  }
}

/**
 * Reconcile abandoned leases after a restart. Finds leases that are still
 * active but whose runs are terminal, and releases them.
 */
export async function reconcileAbandonedLeases(): Promise<number> {
  const now = new Date();
  const activeLeases = await db.agentExecutionLease.findMany({
    where: {
      status: { in: ["reserved", "admitted", "running"] },
    },
    select: { id: true, runId: true, expiresAt: true },
  });

  let released = 0;
  for (const lease of activeLeases) {
    // Check if the lease has expired
    if (lease.expiresAt && lease.expiresAt < now) {
      await db.agentExecutionLease.update({
        where: { id: lease.id },
        data: { status: "released", releasedAt: now },
      });
      released++;
      continue;
    }

    // Check if the run is terminal
    if (lease.runId) {
      const run = await db.pmChannelRun.findUnique({
        where: { id: lease.runId },
        select: { status: true },
      });
      if (run && ["completed", "failed", "timed_out", "cancelled", "superseded"].includes(run.status)) {
        await db.agentExecutionLease.update({
          where: { id: lease.id },
          data: { status: "released", releasedAt: now },
        });
        released++;
      }
    }
  }

  return released;
}

/**
 * Heartbeat an active lease to prevent expiry.
 */
export async function heartbeatExecutionLane(args: {
  runId: string;
}): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LANE_LEASE_MS);
  try {
    await db.agentExecutionLease.updateMany({
      where: { runId: args.runId, status: { in: ["reserved", "admitted", "running"] } },
      data: { heartbeatAt: now, expiresAt },
    });
  } catch {
    // Non-fatal — heartbeat is best-effort
  }
}