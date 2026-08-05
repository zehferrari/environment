// ENV-120 — deterministic permission-grant automation.
//
// Before this module, granting a scoped permission recorded the grant and sent
// a notification, then left three things to chance: the blocker stayed open,
// any older run for the same (task, agent) was still "active", and the next
// execution turn depended on a reply-time heuristic. A human clicking "grant"
// must produce exactly one outcome, so all four effects commit together:
//
//   1. record the grant (auditable authorization comment + activity row)
//   2. clear the blocker round the grant answers
//   3. supersede competing active runs for that task and agent
//   4. reserve exactly one authorization-linked continuation
//
// Idempotency is structural, not advisory: steps 1 and 4 use deterministic
// activity ids, so a double click collides on the unique constraint and rolls
// the whole transaction back rather than granting twice.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { supersedePmChannelContinuations } from "@/lib/agents/pm-channel/continuations";
import {
  blockerRoundClosesOnGrant,
  type BlockerPermissionKind,
} from "@/lib/tasks/formal-blocker";

/** Run states that still claim "a turn is running for this task and agent". */
const COMPETING_RUN_STATUSES = ["queued", "accepted", "streaming"] as const;

export const BLOCKER_PERMISSION_SUPERSEDE_REASON = "blocker_permission_granted";

export function blockerPermissionGrantActivityId(blockerCommentId: string) {
  return `blocker-permission-${blockerCommentId}`;
}

export function blockerPermissionClearedActivityId(blockerCommentId: string) {
  return `blocker-permission-cleared-${blockerCommentId}`;
}

export function blockerPermissionContinuationActivityId(blockerCommentId: string) {
  return `blocker-permission-continuation-${blockerCommentId}`;
}

export type BlockerPermissionGrantOutcome =
  | { granted: false; reason: "already_granted" }
  | {
    granted: true;
    authorizationCommentId: string;
    blockerCleared: boolean;
    supersededRunIds: string[];
  };

export async function applyBlockerPermissionGrant(args: {
  taskId: string;
  projectId: string;
  /** The granting human. */
  actorUserId: string;
  /** Agent slug of the assignee whose runs this grant supersedes. */
  assigneeSlug: string | null;
  blockerCommentId: string;
  permissionKind: BlockerPermissionKind;
  permissionScope: string;
  authorizationBody: string;
  now?: Date;
}): Promise<BlockerPermissionGrantOutcome> {
  const now = args.now ?? new Date();
  // A reporter_approval round ends at the grant itself. A publish_checkpoint
  // round does not: its single-use authorization must stay resolvable from the
  // ACTIVE blocker while the runner consumes it, and the attempt's own
  // settlement closes that exact round (lib/tasks/checkpoint-blocker.ts).
  const closesOnGrant = blockerRoundClosesOnGrant(args.permissionKind);

  try {
    return await db.$transaction(async (tx) => {
      const authorization = await tx.comment.create({
        data: { taskId: args.taskId, userId: args.actorUserId, body: args.authorizationBody },
        select: { id: true },
      });

      await tx.activityLog.create({
        data: {
          id: blockerPermissionGrantActivityId(args.blockerCommentId),
          projectId: args.projectId,
          taskId: args.taskId,
          userId: args.actorUserId,
          kind: "task.blocker.permission.granted",
          payload: JSON.stringify({
            blockerCommentId: args.blockerCommentId,
            permissionKind: args.permissionKind,
            permissionScope: args.permissionScope,
            authorizationCommentId: authorization.id,
          }),
        },
      });

      if (closesOnGrant) {
        await tx.activityLog.create({
          data: {
            id: blockerPermissionClearedActivityId(args.blockerCommentId),
            projectId: args.projectId,
            taskId: args.taskId,
            userId: args.actorUserId,
            kind: "task.blocker.cleared",
            payload: JSON.stringify({
              action: "blocker_permission_granted",
              automated: true,
              reason: "permission_granted",
              blockerCommentId: args.blockerCommentId,
              authorizationCommentId: authorization.id,
            }),
          },
        });
        // The human dependency this alert represented is discharged by the
        // grant. Repository/administrative alerts raise themselves again.
        await tx.task.update({ where: { id: args.taskId }, data: { alertReporter: false } });
      }

      let supersededRunIds: string[] = [];
      if (args.assigneeSlug) {
        const competing = await tx.pmChannelRun.findMany({
          where: {
            taskId: args.taskId,
            agentSlug: args.assigneeSlug,
            status: { in: [...COMPETING_RUN_STATUSES] },
          },
          select: { id: true },
        });
        supersededRunIds = competing.map((run) => run.id);
        if (supersededRunIds.length > 0) {
          // Only stamp a disposition where none was recorded: a run that
          // already declared its end-of-turn outcome keeps it (WFI-005).
          await tx.pmChannelRun.updateMany({
            where: { id: { in: supersededRunIds }, disposition: null },
            data: { disposition: "waiting_external" },
          });
          await tx.pmChannelRun.updateMany({
            where: { id: { in: supersededRunIds } },
            data: {
              status: "superseded",
              finishedAt: now,
              finishedReason: BLOCKER_PERMISSION_SUPERSEDE_REASON,
              lastEventAt: now,
            },
          });
          await supersedePmChannelContinuations(tx, {
            runIds: supersededRunIds,
            reason: BLOCKER_PERMISSION_SUPERSEDE_REASON,
          });
        }
      }

      // The reservation IS the "exactly one" guarantee: the caller sends the
      // wake only when this row was created for the first time.
      await tx.activityLog.create({
        data: {
          id: blockerPermissionContinuationActivityId(args.blockerCommentId),
          projectId: args.projectId,
          taskId: args.taskId,
          userId: args.actorUserId,
          kind: "task.blocker.permission.continuation",
          targetAgent: args.assigneeSlug,
          payload: JSON.stringify({
            blockerCommentId: args.blockerCommentId,
            authorizationCommentId: authorization.id,
            permissionKind: args.permissionKind,
            blockerCleared: closesOnGrant,
            supersededRunIds,
          }),
        },
      });

      return {
        granted: true as const,
        authorizationCommentId: authorization.id,
        blockerCleared: closesOnGrant,
        supersededRunIds,
      };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { granted: false, reason: "already_granted" };
    }
    throw error;
  }
}
