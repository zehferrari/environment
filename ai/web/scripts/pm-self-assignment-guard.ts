import { db } from "@/lib/db";

type ClearReason = {
  rule: "unattributed-agent-self-write";
  activityId: string;
  activityUserId: string | null;
  activityCreatedAt: string;
  via: string | null;
  assignedBy: string | null;
  proposalId: string | null;
  ageMs: number;
};

type Repair = {
  scope: "task" | "epic";
  id: string;
  title: string;
  field: "reporterId" | "assigneeId" | "actingManagerId";
  agentUsername: string;
  action: "cleared";
  // Why the guard fired: the matched activity row + the rule. Reporter
  // clears are separate unconditional policy and carry no reason.
  reason?: ClearReason;
};

// Rows younger than this are never acted on: an in-flight assignment
// transaction (or its follow-up writes) must be allowed to settle before
// the guard treats the log as the final word.
const SETTLE_WINDOW_MS = 60_000;

async function latestActivityRow(args: {
  taskId?: string;
  projectId?: string;
  payloadContains?: string;
  kinds: string[];
}) {
  return db.activityLog.findFirst({
    where: {
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.payloadContains ? { payload: { contains: args.payloadContains } } : {}),
      kind: { in: args.kinds },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, userId: true, payload: true, createdAt: true },
  });
}

type ParsedAttribution = {
  attributed: boolean;
  via: string | null;
  assignedBy: string | null;
  proposalId: string | null;
};

// Every legitimate app path stamps at least one of via / assignedBy /
// proposalId into the payload. Rows without any of them are either the
// human UI edit (human actor, excluded by the actor rules below) or
// out-of-band writes — exactly what this guard exists for. Unparseable or
// missing payloads count as unattributed: no app path emits those.
function parseAttribution(payload: string | null): ParsedAttribution {
  let parsed: unknown = null;
  if (payload) {
    try {
      parsed = JSON.parse(payload);
    } catch {
      parsed = null;
    }
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const str = (key: string): string | null => (typeof obj[key] === "string" ? (obj[key] as string) : null);
  const attributed = obj.via !== undefined || obj.assignedBy !== undefined || obj.proposalId !== undefined;
  return { attributed, via: str("via"), assignedBy: str("assignedBy"), proposalId: str("proposalId") };
}

// Clear only when the latest matching row was written BY the current holder
// themselves, that actor is an agent, the payload carries no attribution,
// and the row is old enough to be settled. Returns the reason to log, or
// null when the assignment must be left alone.
async function unattributedSelfWriteReason(
  row: Awaited<ReturnType<typeof latestActivityRow>>,
  holderUserId: string,
): Promise<ClearReason | null> {
  if (!row || row.userId !== holderUserId) return null;
  const actor = await db.user.findUnique({ where: { id: holderUserId }, select: { kind: true } });
  if (actor?.kind !== "agent") return null;
  const attribution = parseAttribution(row.payload);
  if (attribution.attributed) return null;
  const ageMs = Date.now() - row.createdAt.getTime();
  if (ageMs < SETTLE_WINDOW_MS) return null;
  return {
    rule: "unattributed-agent-self-write",
    activityId: row.id,
    activityUserId: row.userId,
    activityCreatedAt: row.createdAt.toISOString(),
    via: attribution.via,
    assignedBy: attribution.assignedBy,
    proposalId: attribution.proposalId,
    ageMs,
  };
}

async function main() {
  const monitor = await db.user.findFirst({
    where: {
      status: "active",
      kind: "agent",
      agent: { is: { role: "monitor", deactivatedAt: null } },
    },
    select: { id: true },
  }) ?? await db.user.findFirst({
    where: { kind: "human", status: "active", isOwner: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!monitor) throw new Error("No monitor/human user available for self-assignment guard logs");

  const repairs: Repair[] = [];

  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      OR: [
        { reporter: { is: { kind: "agent" } } },
        { assignee: { is: { kind: "agent" } } },
        { actingManager: { is: { kind: "agent" } } },
      ],
    },
    select: {
      id: true,
      title: true,
      projectId: true,
      reporterId: true,
      assigneeId: true,
      actingManagerId: true,
      reporter: { select: { username: true, kind: true } },
      assignee: { select: { username: true, kind: true } },
      actingManager: { select: { username: true, kind: true } },
    },
  });

  for (const task of tasks) {
    const data: { reporterId?: null; assigneeId?: null; actingManagerId?: null } = {};
    const localRepairs: Repair[] = [];
    if (task.reporterId && task.reporter?.kind === "agent") {
      data.reporterId = null;
      localRepairs.push({
        scope: "task",
        id: task.id,
        title: task.title,
        field: "reporterId",
        agentUsername: task.reporter.username,
        action: "cleared",
      });
    }
    if (task.assigneeId && task.assignee?.kind === "agent") {
      const reason = await unattributedSelfWriteReason(
        await latestActivityRow({ taskId: task.id, kinds: ["task.assign"] }),
        task.assigneeId,
      );
      if (reason) {
        data.assigneeId = null;
        localRepairs.push({
          scope: "task",
          id: task.id,
          title: task.title,
          field: "assigneeId",
          agentUsername: task.assignee.username,
          action: "cleared",
          reason,
        });
      }
    }
    if (task.actingManagerId && task.actingManager?.kind === "agent") {
      const reason = await unattributedSelfWriteReason(
        await latestActivityRow({ taskId: task.id, kinds: ["task.acting_manager"] }),
        task.actingManagerId,
      );
      if (reason) {
        data.actingManagerId = null;
        localRepairs.push({
          scope: "task",
          id: task.id,
          title: task.title,
          field: "actingManagerId",
          agentUsername: task.actingManager.username,
          action: "cleared",
          reason,
        });
      }
    }
    if (Object.keys(data).length > 0) {
      await db.$transaction([
        db.task.update({ where: { id: task.id }, data }),
        db.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: monitor.id,
            kind: "pm.self_assignment_guard",
            payload: JSON.stringify({ repairs: localRepairs }),
          },
        }),
      ]);
      repairs.push(...localRepairs);
    }
  }

  const epics = await db.epic.findMany({
    where: {
      deletedAt: null,
      OR: [
        { reporter: { is: { kind: "agent" } } },
        { actingManager: { is: { kind: "agent" } } },
      ],
    },
    select: {
      id: true,
      title: true,
      projectId: true,
      reporterId: true,
      actingManagerId: true,
      reporter: { select: { username: true, kind: true } },
      actingManager: { select: { username: true, kind: true } },
    },
  });

  for (const epic of epics) {
    const data: { reporterId?: null; actingManagerId?: null } = {};
    const localRepairs: Repair[] = [];
    if (epic.reporterId && epic.reporter?.kind === "agent") {
      data.reporterId = null;
      localRepairs.push({
        scope: "epic",
        id: epic.id,
        title: epic.title,
        field: "reporterId",
        agentUsername: epic.reporter.username,
        action: "cleared",
      });
    }
    if (epic.actingManagerId && epic.actingManager?.kind === "agent") {
      const reason = await unattributedSelfWriteReason(
        await latestActivityRow({
          projectId: epic.projectId,
          payloadContains: epic.id,
          kinds: ["epic.acting_manager"],
        }),
        epic.actingManagerId,
      );
      if (reason) {
        data.actingManagerId = null;
        localRepairs.push({
          scope: "epic",
          id: epic.id,
          title: epic.title,
          field: "actingManagerId",
          agentUsername: epic.actingManager.username,
          action: "cleared",
          reason,
        });
      }
    }
    if (Object.keys(data).length > 0) {
      await db.$transaction([
        db.epic.update({ where: { id: epic.id }, data }),
        db.activityLog.create({
          data: {
            projectId: epic.projectId,
            userId: monitor.id,
            kind: "pm.self_assignment_guard",
            payload: JSON.stringify({ repairs: localRepairs }),
          },
        }),
      ]);
      repairs.push(...localRepairs);
    }
  }

  console.log(JSON.stringify({ ok: true, repairCount: repairs.length, repairs }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
