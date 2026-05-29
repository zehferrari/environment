import { db } from "@/lib/db";
import type {
  PmChannelReplyTarget,
  PmChannelTurnKind,
  SendPmChannelTurnResult,
} from "@/lib/agents/openclaw-pm-channel";
import type { PmChannelStreamEventKind } from "@/lib/agents/pm-channel-stream";

export type PmChannelRunStatus =
  | "queued"
  | "accepted"
  | "streaming"
  | "complete"
  | "failed";

const FIRST_ACTIVITY_TIMEOUT_MS = Number.parseInt(
  process.env.PM_OPENCLAW_FIRST_ACTIVITY_TIMEOUT_MS ?? "300000",
  10,
);
const STREAM_INACTIVE_TIMEOUT_MS = Number.parseInt(
  process.env.PM_OPENCLAW_STREAM_INACTIVE_TIMEOUT_MS ?? "180000",
  10,
);

export function pmChannelRunTargetKey(target: PmChannelReplyTarget): string {
  if (target.kind === "direct") {
    return `direct:${target.agentSlug}:${target.messageId}`;
  }
  if (target.kind === "epic-chat") {
    return `epic-chat:${target.agentSlug}:${target.epicId}:${target.messageId}`;
  }
  return `${target.kind}:${target.agentSlug}:${target.taskId}:${target.messageId}`;
}

function targetIds(target: PmChannelReplyTarget) {
  return {
    taskId: target.kind === "task-chat" || target.kind === "task-comment" ? target.taskId : null,
    epicId: target.kind === "epic-chat" ? target.epicId : null,
  };
}

function clippedError(error: string | null | undefined) {
  if (!error) return null;
  return error.length > 2_000 ? error.slice(0, 2_000) : error;
}

async function record(run: () => Promise<unknown>, label: string) {
  try {
    await run();
  } catch (err) {
    console.warn(`[pm-channel] failed to persist ${label}`, err);
  }
}

function timeoutMs(value: number, fallback: number) {
  return Number.isFinite(value) && value >= 30_000 ? value : fallback;
}

function replyActivityKind(target: PmChannelReplyTarget) {
  if (target.kind === "direct") return "agent.direct_chat.reply";
  if (target.kind === "epic-chat") return "epic.chat.reply";
  if (target.kind === "task-comment") return "task.comment";
  return "task.chat.reply";
}

function silentActivityKind(target: PmChannelReplyTarget) {
  if (target.kind === "direct") return "agent.direct_chat.silent";
  if (target.kind === "epic-chat") return "epic.chat.silent";
  if (target.kind === "task-comment") return "task.comment.silent";
  return "task.chat.silent";
}

export async function pmChannelTargetHasDurableReply(target: PmChannelReplyTarget) {
  const row = await db.activityLog.findFirst({
    where: {
      kind: { in: [replyActivityKind(target), silentActivityKind(target)] },
      targetAgent: target.agentSlug,
      payload: { contains: `"inReplyToMessageId":"${target.messageId}"` },
    },
    select: { id: true },
  });
  return Boolean(row);
}

async function failRun(target: PmChannelReplyTarget, error: string) {
  const now = new Date();
  return db.pmChannelRun.update({
    where: { targetKey: pmChannelRunTargetKey(target) },
    data: {
      status: "failed",
      error: clippedError(error),
      failedAt: now,
      lastEventAt: now,
    },
    select: {
      status: true,
      error: true,
      lastEventAt: true,
      createdAt: true,
      updatedAt: true,
      acceptedAt: true,
      streamingAt: true,
      completedAt: true,
      failedAt: true,
    },
  });
}

export async function recordPmChannelRunQueued(args: {
  target: PmChannelReplyTarget;
  kind: PmChannelTurnKind;
  projectId?: string | null;
  gatewayPort?: number | null;
  sessionKey?: string | null;
}) {
  const now = new Date();
  const ids = targetIds(args.target);
  await record(
    () => db.pmChannelRun.upsert({
      where: { targetKey: pmChannelRunTargetKey(args.target) },
      create: {
        targetKey: pmChannelRunTargetKey(args.target),
        kind: args.kind,
        agentSlug: args.target.agentSlug,
        messageId: args.target.messageId,
        projectId: args.projectId ?? null,
        taskId: ids.taskId,
        epicId: ids.epicId,
        sessionKey: args.sessionKey ?? null,
        gatewayPort: args.gatewayPort ?? null,
        status: "queued",
        error: null,
        lastEventAt: now,
      },
      update: {
        kind: args.kind,
        agentSlug: args.target.agentSlug,
        messageId: args.target.messageId,
        projectId: args.projectId ?? null,
        taskId: ids.taskId,
        epicId: ids.epicId,
        sessionKey: args.sessionKey ?? null,
        gatewayPort: args.gatewayPort ?? null,
        httpStatus: null,
        status: "queued",
        error: null,
        acceptedAt: null,
        streamingAt: null,
        completedAt: null,
        failedAt: null,
        lastEventAt: now,
      },
    }),
    "queued run",
  );
}

export async function recordPmChannelRunDispatch(args: {
  target: PmChannelReplyTarget;
  result: SendPmChannelTurnResult;
}) {
  const now = new Date();
  const ok = args.result.ok;
  await record(
    () => db.pmChannelRun.update({
      where: { targetKey: pmChannelRunTargetKey(args.target) },
      data: {
        httpStatus: args.result.status ?? null,
        status: ok ? "accepted" : "failed",
        error: ok ? null : clippedError(args.result.error),
        acceptedAt: ok ? now : null,
        failedAt: ok ? null : now,
        lastEventAt: now,
      },
    }),
    "dispatch run state",
  );
}

export async function recordPmChannelRunWorkflowAction(args: {
  taskId: string;
  agentSlug: string;
  messageId: string;
  action: string;
}) {
  const now = new Date();
  const targetKey = pmChannelRunTargetKey({
    kind: "task-comment",
    agentSlug: args.agentSlug,
    taskId: args.taskId,
    messageId: args.messageId,
  });
  await record(
    () => db.pmChannelRun.updateMany({
      where: {
        targetKey,
        status: { in: ["queued", "accepted", "streaming"] },
      },
      data: {
        status: "complete",
        error: null,
        completedAt: now,
        failedAt: null,
        lastEventAt: now,
      },
    }),
    `workflow action run state (${args.action})`,
  );
}

export async function recordPmChannelRunEvent(args: {
  target: PmChannelReplyTarget;
  event: PmChannelStreamEventKind;
  error?: string | null;
}) {
  const now = new Date();
  const ids = targetIds(args.target);
  const targetKey = pmChannelRunTargetKey(args.target);

  if (args.event === "done") {
    await record(
      async () => {
        const existing = await db.pmChannelRun.findUnique({
          where: { targetKey },
          select: { status: true },
        });
        if (existing?.status === "complete" || await pmChannelTargetHasDurableReply(args.target)) {
          await db.pmChannelRun.upsert({
            where: { targetKey },
            create: {
              targetKey,
              kind: args.target.kind,
              agentSlug: args.target.agentSlug,
              messageId: args.target.messageId,
              taskId: ids.taskId,
              epicId: ids.epicId,
              status: "complete",
              completedAt: now,
              failedAt: null,
              lastEventAt: now,
            },
            update: {
              status: "complete",
              error: null,
              completedAt: now,
              failedAt: null,
              lastEventAt: now,
            },
          });
          return;
        }
        await db.pmChannelRun.upsert({
          where: { targetKey },
          create: {
            targetKey,
            kind: args.target.kind,
            agentSlug: args.target.agentSlug,
            messageId: args.target.messageId,
            taskId: ids.taskId,
            epicId: ids.epicId,
            status: "failed",
            error: "Agent finished without posting a reply.",
            failedAt: now,
            lastEventAt: now,
          },
          update: {
            status: "failed",
            error: "Agent finished without posting a reply.",
            failedAt: now,
            lastEventAt: now,
          },
        });
      },
      "done run state",
    );
    return;
  }

  if (args.event === "error") {
    await record(
      async () => {
        const existing = await db.pmChannelRun.findUnique({
          where: { targetKey },
          select: { status: true },
        });
        if (existing?.status === "complete" || await pmChannelTargetHasDurableReply(args.target)) {
          await db.pmChannelRun.upsert({
            where: { targetKey },
            create: {
              targetKey,
              kind: args.target.kind,
              agentSlug: args.target.agentSlug,
              messageId: args.target.messageId,
              taskId: ids.taskId,
              epicId: ids.epicId,
              status: "complete",
              completedAt: now,
              failedAt: null,
              lastEventAt: now,
            },
            update: {
              status: "complete",
              error: null,
              completedAt: now,
              failedAt: null,
              lastEventAt: now,
            },
          });
          return;
        }

        await db.pmChannelRun.upsert({
          where: { targetKey },
          create: {
            targetKey,
            kind: args.target.kind,
            agentSlug: args.target.agentSlug,
            messageId: args.target.messageId,
            taskId: ids.taskId,
            epicId: ids.epicId,
            status: "failed",
            error: clippedError(args.error) ?? "OpenClaw stream failed",
            failedAt: now,
            lastEventAt: now,
          },
          update: {
            status: "failed",
            error: clippedError(args.error) ?? "OpenClaw stream failed",
            failedAt: now,
            lastEventAt: now,
          },
        });
      },
      "error run state",
    );
    return;
  }

  const status: PmChannelRunStatus =
    args.event === "final"
      ? "complete"
      : "streaming";
  await record(
    async () => {
      const existing = await db.pmChannelRun.findUnique({
        where: { targetKey },
        select: { streamingAt: true },
      });
      const firstTokenAt = existing?.streamingAt ?? now;
      await db.pmChannelRun.upsert({
        where: { targetKey },
        create: {
          targetKey,
          kind: args.target.kind,
          agentSlug: args.target.agentSlug,
          messageId: args.target.messageId,
          taskId: ids.taskId,
          epicId: ids.epicId,
          status,
          error: null,
          // A final event can be the first emitted token for very short replies;
          // keep first-token latency visible instead of leaving it blank.
          streamingAt: firstTokenAt,
          completedAt: status === "complete" ? now : null,
          failedAt: null,
          lastEventAt: now,
        },
        update: {
          status,
          error: null,
          streamingAt: firstTokenAt,
          completedAt: status === "complete" ? now : undefined,
          failedAt: null,
          lastEventAt: now,
        },
      });
    },
    "stream run state",
  );
}

export async function getPmChannelRunSnapshot(target: PmChannelReplyTarget) {
  const run = await db.pmChannelRun.findUnique({
    where: { targetKey: pmChannelRunTargetKey(target) },
    select: {
      status: true,
      error: true,
      lastEventAt: true,
      createdAt: true,
      updatedAt: true,
      acceptedAt: true,
      streamingAt: true,
      completedAt: true,
      failedAt: true,
    },
  });
  if (!run) return null;

  const now = Date.now();
  const lastEventAt = run.lastEventAt?.getTime() ?? run.updatedAt.getTime();

  if (run.status === "complete" && run.completedAt) return run;

  if (
    (run.status === "queued" || run.status === "accepted") &&
    now - lastEventAt > timeoutMs(FIRST_ACTIVITY_TIMEOUT_MS, 150_000)
  ) {
    return failRun(
      target,
      "Agent did not start streaming after the local handoff.",
    );
  }

  if (
    run.status === "streaming" &&
    now - lastEventAt > timeoutMs(STREAM_INACTIVE_TIMEOUT_MS, 180_000)
  ) {
    return failRun(
      target,
      "Agent stream stopped before a final reply was delivered.",
    );
  }

  return run;
}
