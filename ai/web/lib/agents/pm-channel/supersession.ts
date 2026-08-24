import { db } from "@/lib/db";
import { resolvePmChannelToken } from "@/lib/agents/pm-channel/openclaw";
import { releaseExecutionLane } from "@/lib/agents/pm-channel/execution-lane";

export type SupersessionFenceResult =
  | { ok: true; cancelledRunIds: string[] }
  | { ok: false; cancelledRunIds: string[]; error: string };

function clipped(value: string, max = 2_000) {
  return value.length > max ? value.slice(0, max) : value;
}

export async function abortGatewaySession(args: {
  agentSlug: string;
  gatewayPort: number;
  sessionKey: string;
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
      body: JSON.stringify({ sessionKey: args.sessionKey }),
      signal: AbortSignal.timeout(10_000),
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
    if (response.ok) return { ok: true as const };
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
  const predecessors = await db.pmChannelRun.findMany({
    where: {
      supersededByRunId: args.replacementRunId,
      cancellationAcknowledgedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      agentSlug: true,
      gatewayPort: true,
      sessionKey: true,
      admittedAt: true,
      streamingAt: true,
    },
  });
  const cancelledRunIds: string[] = [];
  for (const predecessor of predecessors) {
    const requestedAt = new Date();
    await db.pmChannelRun.update({
      where: { id: predecessor.id },
      data: { cancellationRequestedAt: requestedAt, cancellationError: null },
    });

    // A queued run was never handed to a gateway, so retiring its job is the
    // complete cancellation acknowledgement.
    const wasDelivered = predecessor.admittedAt !== null || predecessor.streamingAt !== null;
    if (!wasDelivered) {
      await db.pmChannelRun.update({
        where: { id: predecessor.id },
        data: { cancellationAcknowledgedAt: new Date(), cancellationError: null },
      });
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
      fetchImpl: args.fetchImpl,
    });
    if (!aborted.ok) {
      await db.pmChannelRun.update({
        where: { id: predecessor.id },
        data: { cancellationError: aborted.error },
      });
      return { ok: false, cancelledRunIds, error: aborted.error };
    }
    await db.pmChannelRun.update({
      where: { id: predecessor.id },
      data: { cancellationAcknowledgedAt: new Date(), cancellationError: null },
    });
    await releaseExecutionLane({ runId: predecessor.id });
    cancelledRunIds.push(predecessor.id);
  }
  return { ok: true, cancelledRunIds };
}
