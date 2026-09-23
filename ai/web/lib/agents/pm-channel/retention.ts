import { db } from "@/lib/db";
import { applyPmChannelStreamInput, emptyPmChannelStreamState, type PmChannelStreamInput, type PmChannelStreamState } from "./stream";
import type { PersistedStreamInput } from "./stream-log";

const TERMINAL = ["completed", "failed", "timed_out", "cancelled", "superseded"];
const PAYLOAD_TOMBSTONE = JSON.stringify({ retained: false, reason: "terminal_payload_retention" });

function retentionDays(name: string, fallback: number) {
  const days = Number(process.env[name]);
  return Number.isFinite(days) && days >= 1 ? days : fallback;
}

/** Compact only settled runs, preserving exactly what reconnecting clients can
 * reconstruct (including aborted partial text, reasoning, tool and error metadata).
 * The snapshot and deletion share a transaction; malformed history is retained.
 * Domain comments, checkpoints, tool evidence and audit identities are untouched.
 */
export async function maintainPmRuntimeHistory(options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const streamBefore = new Date(now.getTime() - retentionDays("PM_TERMINAL_STREAM_RETENTION_DAYS", 7) * 86_400_000);
  const payloadBefore = new Date(now.getTime() - retentionDays("PM_TERMINAL_PAYLOAD_RETENTION_DAYS", 30) * 86_400_000);
  const runs = await db.pmChannelRun.findMany({
    where: { status: { in: TERMINAL }, updatedAt: { lt: streamBefore }, streamEvents: { some: { kind: { in: ["partial", "token", "reasoning"] } } } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: limit, select: { id: true },
  });
  let compactedRuns = 0;
  let removedFrames = 0;
  for (const candidate of runs) {
    const count = await db.$transaction(async tx => {
      const run = await tx.pmChannelRun.findUnique({ where: { id: candidate.id } });
      if (!run || !TERMINAL.includes(run.status) || run.updatedAt >= streamBefore) return 0;
      const rows = await tx.pmChannelStreamEvent.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
      if (!rows.length) return 0;
      // Only the content portion is saved; replay restores the caller's target.
      const target = { kind: "direct" as const, agentSlug: run.agentSlug, messageId: run.messageId };
      let state = emptyPmChannelStreamState(target);
      for (const row of rows) {
        let payload: PersistedStreamInput;
        try { payload = JSON.parse(row.payload); } catch { return 0; }
        if (!payload || typeof payload !== "object") return 0;
        state = applyPmChannelStreamInput(state, { ...payload, target, event: row.kind as PmChannelStreamInput["event"], seq: row.seq });
      }
      // A canceled process may never have sent a terminal callback. Its durable
      // run state is authoritative, while all accumulated content is preserved.
      state.runStatus = run.status as PmChannelStreamState["runStatus"];
      state.status = ["failed", "timed_out", "superseded"].includes(run.status) ? "error" : "done";
      state.error = state.error ?? run.error;
      state.provider = state.provider ?? run.provider;
      state.model = state.model ?? run.model;
      const { key: _key, target: _target, seq: _seq, updatedAt: _updatedAt, ...snapshot } = state;
      const seq = Math.max(run.streamSeq, rows.at(-1)!.seq) + 1;
      await tx.pmChannelRun.update({ where: { id: run.id }, data: { streamSeq: seq } });
      await tx.pmChannelStreamEvent.create({ data: { runId: run.id, seq, kind: "status", payload: JSON.stringify({ event: "status", snapshot }) } });
      return (await tx.pmChannelStreamEvent.deleteMany({ where: { runId: run.id, seq: { lt: seq } } })).count;
    });
    if (count) { compactedRuns++; removedFrames += count; }
  }
  const jobs = await db.pmChannelJob.findMany({ where: { status: { in: ["complete", "failed", "canceled"] }, updatedAt: { lt: payloadBefore }, payload: { not: PAYLOAD_TOMBSTONE }, run: { status: { in: TERMINAL } } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: limit, select: { id: true } });
  const trimmedJobs = await db.pmChannelJob.updateMany({ where: { id: { in: jobs.map(row => row.id) }, status: { in: ["complete", "failed", "canceled"] }, run: { status: { in: TERMINAL } } }, data: { payload: PAYLOAD_TOMBSTONE } });
  const deliveries = await db.pmEventDelivery.findMany({ where: { receivedAt: { lt: payloadBefore }, deliveryStatus: { in: ["delivered", "failed", "unmatched", "skipped"] }, envelope: { not: PAYLOAD_TOMBSTONE } },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }], take: limit, select: { id: true } });
  const trimmedDeliveries = await db.pmEventDelivery.updateMany({ where: { id: { in: deliveries.map(row => row.id) }, deliveryStatus: { in: ["delivered", "failed", "unmatched", "skipped"] } }, data: { envelope: PAYLOAD_TOMBSTONE } });
  return { compactedRuns, removedFrames, trimmedJobs: trimmedJobs.count, trimmedDeliveries: trimmedDeliveries.count };
}
