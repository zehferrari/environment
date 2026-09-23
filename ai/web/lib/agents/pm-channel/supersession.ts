import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { resolvePmChannelToken } from "@/lib/agents/pm-channel/openclaw";
import { releaseExecutionLane } from "@/lib/agents/pm-channel/execution-lane";

export type SupersessionFenceResult =
  | { ok: true; cancelledRunIds: string[] }
  | { ok: false; cancelledRunIds: string[]; error: string };

/** Transactional half of reopening a plan. The authenticated caller must remain
 * valid until its terminal workflow action commits; every other generation is
 * retired now, while its execution lane remains held until process cancellation
 * is acknowledged. The durable request also covers a human reopen (no successor).
 */
export async function fenceTaskRunsForPlanRevision(tx: Prisma.TransactionClient, args: {
  taskId: string;
  currentRunId?: string | null;
  expectedEpisodeId?: string | null;
}) {
  const now = new Date();
  const active = await tx.pmChannelRun.findMany({
    where: { taskId: args.taskId, status: { in: ["queued", "claimed", "delivered", "waiting_capacity", "accepted", "admitted", "streaming"] },
      ...(args.currentRunId ? { id: { not: args.currentRunId } } : {}) },
    select: { id: true, status: true },
  });
  const runIds = active.map(row => row.id);
  if (runIds.length > 0) {
    await tx.pmChannelRun.updateMany({ where: { id: { in: runIds } }, data: {
      status: "superseded", finishedAt: now, finishedReason: "plan_revision_required", disposition: "continue",
      cancellationRequestedAt: now, cancellationAcknowledgedAt: null, cancellationError: null,
    } });
    // Preserve delivery uncertainty after changing status to superseded. A
    // claimed HTTP dispatch may be in flight; absence of admittedAt is not
    // evidence that no process exists.
    await tx.pmChannelRun.updateMany({ where: { id: { in: active.filter(row => !["queued", "waiting_capacity"].includes(row.status)).map(row => row.id) } },
      data: { finishedReason: "plan_revision_required_after_dispatch" } });
    await tx.pmChannelJob.updateMany({ where: { runId: { in: runIds }, status: { in: ["queued", "claimed", "accepted", "retryable"] } }, data: {
      status: "canceled", claimedBy: null, claimedAt: null, completedAt: now, lastError: "approved plan reopened for revision",
    } });
  }
  await tx.pmChannelContinuation.updateMany({ where: { taskId: args.taskId, status: { in: ["armed", "queued", "dispatching"] } },
    data: { status: "superseded", lastError: "approved plan reopened for revision" } });
  const episodes = await tx.taskExecutionEpisode.updateMany({ where: { taskId: args.taskId, status: "open",
    ...(args.currentRunId ? { NOT: { OR: [{ runId: args.currentRunId }, ...(args.expectedEpisodeId ? [{ id: args.expectedEpisodeId }] : [])] } } : {}) },
    data: { status: "closed", closeReason: "plan_revision_required", closedAt: now } });
  return { runIds, closedEpisodes: episodes.count };
}

function clipped(value: string, max = 2_000) {
  return value.length > max ? value.slice(0, max) : value;
}

export async function abortGatewaySession(args: {
  agentSlug: string;
  gatewayPort: number;
  sessionKey: string;
  gatewayDispatchId?: string | null;
  fetchImpl?: typeof fetch;
}) {
  const token = await resolvePmChannelToken(args.agentSlug);
  if (!token) return { ok: false, error: `missing PM channel token for ${args.agentSlug}` };
  const f = args.fetchImpl ?? fetch;
  try {
    const response = await f(`http://127.0.0.1:${args.gatewayPort}/pm-channel/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sessionKey: args.sessionKey,
        ...(args.gatewayDispatchId ? { gatewayDispatchId: args.gatewayDispatchId } : {}),
      }),
      // Queue cancellation (5s), embedded drain (10s), registration grace
      // (5s), plus transport headroom. Do not time out a valid process fence.
      signal: AbortSignal.timeout(25_000),
    });
    // 404 means the gateway no longer owns that process/session. That is a
    // positive fence: there is nothing left to abort before replacement.
    if (response.status === 404) return { ok: true as const };
    const body = await response.text().catch(() => "");
    if (response.ok) {
      try {
        const payload = JSON.parse(body) as { aborted?: unknown; reason?: unknown };
        if (payload.aborted === true || payload.reason === "not_active") {
          return { ok: true as const };
        }
        return {
          ok: false as const,
          error: clipped(
            typeof payload.reason === "string"
              ? `gateway did not acknowledge cancellation: ${payload.reason}`
              : "gateway did not acknowledge cancellation",
          ),
        };
      } catch {
        return { ok: false as const, error: "gateway returned an invalid cancellation acknowledgement" };
      }
    }
    return {
      ok: false as const,
      error: clipped(body.trim() || `gateway cancellation returned HTTP ${response.status}`),
    };
  } catch (error) {
    return {
      ok: false as const,
      error: clipped(error instanceof Error ? error.message : String(error)),
    };
  }
}

export async function steerGatewaySession(args: {
  agentSlug: string;
  gatewayPort: number;
  sessionKey: string;
  text: string;
  fetchImpl?: typeof fetch;
}) {
  const token = await resolvePmChannelToken(args.agentSlug);
  if (!token) return { ok: false as const, error: `missing PM channel token for ${args.agentSlug}` };
  const f = args.fetchImpl ?? fetch;
  try {
    const response = await f(`http://127.0.0.1:${args.gatewayPort}/pm-channel/steer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sessionKey: args.sessionKey, text: args.text }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text().catch(() => "");
    if (response.ok) {
      const result = JSON.parse(body) as { queued?: boolean; delivery?: string };
      if (result.delivery === "workflow_response" && result.queued === false) {
        return { ok: true as const, queued: false, delivery: "workflow_response" as const };
      }
      if (result.queued === true) return { ok: true as const, queued: true, delivery: "live" as const };
      return { ok: false as const, error: "gateway did not acknowledge checkpoint delivery" };
    }
    return {
      ok: false as const,
      error: clipped(body.trim() || `gateway steering returned HTTP ${response.status}`),
    };
  } catch (error) {
    return {
      ok: false as const,
      error: clipped(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Fence every live process superseded by `replacementRunId` before the new
 * run is delivered. Database supersession alone is not enough: the old model
 * can continue writing its worktree even after its row becomes terminal.
 */
export async function fenceSupersededPmChannelRuns(args: {
  replacementRunId: string;
  fetchImpl?: typeof fetch;
}): Promise<SupersessionFenceResult> {
  const replacement = await db.pmChannelRun.findUnique({ where: { id: args.replacementRunId }, select: { taskId: true } });
  return fencePendingPmChannelCancellations({ replacementRunId: args.replacementRunId, taskId: replacement?.taskId, fetchImpl: args.fetchImpl });
}

/** Drain durable cancellation requests before any replacement dispatch. Requests
 * without a replacement run (for example human plan revisions) are equally binding.
 */
export async function fencePendingPmChannelCancellations(args: {
  replacementRunId?: string;
  taskId?: string | null;
  runId?: string;
  fetchImpl?: typeof fetch;
}): Promise<SupersessionFenceResult> {
  if (!args.replacementRunId && !args.taskId && !args.runId) throw new Error("cancellation fence requires a scope");
  const predecessors = await db.pmChannelRun.findMany({
    where: {
      ...(args.runId ? { id: args.runId } : { OR: [
        ...(args.replacementRunId ? [{ supersededByRunId: args.replacementRunId }] : []),
        ...(args.taskId ? [{ taskId: args.taskId, cancellationRequestedAt: { not: null }, ...(args.replacementRunId ? { id: { not: args.replacementRunId } } : {}) }] : []),
      ] }),
      cancellationAcknowledgedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      agentSlug: true,
      gatewayPort: true,
      sessionKey: true,
      status: true,
      acceptedAt: true,
      admittedAt: true,
      streamingAt: true,
      gatewayDispatchId: true,
      httpStatus: true,
      cancellationRequestedAt: true,
      finishedReason: true,
    },
  });
  const cancelledRunIds: string[] = [];
  for (const predecessor of predecessors) {
    const requestedAt = new Date();
    await db.pmChannelRun.update({
      where: { id: predecessor.id },
      data: { cancellationRequestedAt: predecessor.cancellationRequestedAt ?? requestedAt, cancellationError: null },
    });

    // A queued run was never handed to a gateway, so retiring its job is the
    // complete cancellation acknowledgement.
    const wasDelivered =
      predecessor.status === "delivered" ||
      predecessor.status === "accepted" ||
      predecessor.status === "waiting_capacity" ||
      predecessor.status === "admitted" ||
      predecessor.status === "streaming" ||
      predecessor.finishedReason === "plan_revision_required_after_dispatch" ||
      predecessor.finishedReason === "episode_tool_budget_exhausted" ||
      predecessor.gatewayDispatchId !== null ||
      (predecessor.httpStatus !== null && predecessor.httpStatus >= 200 && predecessor.httpStatus < 300) ||
      predecessor.acceptedAt !== null ||
      predecessor.admittedAt !== null ||
      predecessor.streamingAt !== null;
    if (!wasDelivered) {
      const acknowledged = await db.pmChannelRun.updateMany({
        where: { id: predecessor.id, gatewayDispatchId: predecessor.gatewayDispatchId, httpStatus: predecessor.httpStatus },
        data: { cancellationAcknowledgedAt: new Date(), cancellationError: null },
      });
      if (!acknowledged.count) return { ok: false, cancelledRunIds, error: "gateway handoff changed while acknowledging cancellation; retry required" };
      await releaseExecutionLane({ runId: predecessor.id });
      cancelledRunIds.push(predecessor.id);
      continue;
    }
    if (!predecessor.gatewayPort || !predecessor.sessionKey) {
      const error = "superseded run was delivered but has no gateway session identity";
      await db.pmChannelRun.update({
        where: { id: predecessor.id },
        data: { cancellationError: error },
      });
      return { ok: false, cancelledRunIds, error };
    }

    const aborted = await abortGatewaySession({
      agentSlug: predecessor.agentSlug,
      gatewayPort: predecessor.gatewayPort,
      sessionKey: predecessor.sessionKey,
      gatewayDispatchId: predecessor.gatewayDispatchId,
      fetchImpl: args.fetchImpl,
    });
    if (!aborted.ok) {
      await db.pmChannelRun.update({
        where: { id: predecessor.id },
        data: { cancellationError: aborted.error },
      });
      return { ok: false, cancelledRunIds, error: aborted.error };
    }
    const acknowledged = await db.pmChannelRun.updateMany({
      where: { id: predecessor.id, gatewayDispatchId: predecessor.gatewayDispatchId, httpStatus: predecessor.httpStatus },
      data: { cancellationAcknowledgedAt: new Date(), cancellationError: null },
    });
    if (!acknowledged.count) return { ok: false, cancelledRunIds, error: "gateway handoff changed during cancellation; retry required" };
    await releaseExecutionLane({ runId: predecessor.id });
    cancelledRunIds.push(predecessor.id);
  }
  return { ok: true, cancelledRunIds };
}
