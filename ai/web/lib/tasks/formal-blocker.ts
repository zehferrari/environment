type TaskActivityKindRow = {
  taskId?: string | null;
  kind: string;
  payload?: string | null;
  createdAt?: Date | string | number | null;
};

type TaskBlockerCommentRow = {
  id: string;
  taskId: string | null;
  createdAt: Date | string | number;
};

export const BLOCKER_PERMISSION_KINDS = [
  "reporter_approval",
  "publish_checkpoint",
] as const;

export type BlockerPermissionKind = (typeof BLOCKER_PERMISSION_KINDS)[number];

export type BlockerPermissionRequest = {
  kind: BlockerPermissionKind;
  scope: string;
  taskKey?: string | null;
  taskBranch?: string | null;
  epicBranch?: string | null;
};

export type ActiveFormalBlocker = {
  commentId: string | null;
  permissionRequest: BlockerPermissionRequest | null;
  raisedAt: Date | string | number | null;
};

export type BlockerPermissionGrant = {
  authorizationCommentId: string | null;
  grantedAt: Date | string | number | null;
};

export type ActiveFormalBlockerState = ActiveFormalBlocker & {
  permissionGrant: BlockerPermissionGrant | null;
};

const FORMAL_BLOCKER_KINDS = new Set([
  "task.blocker",
  "task.extra_work.blocker",
  "task.blocker.cleared",
]);

export function isBlockerPermissionKind(value: unknown): value is BlockerPermissionKind {
  return typeof value === "string" && (BLOCKER_PERMISSION_KINDS as readonly string[]).includes(value);
}

function parsedPayload(payload: string | null | undefined) {
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function timestamp(value: Date | string | number) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function blockerMetadataFromPayload(payload: string | null | undefined): ActiveFormalBlocker {
  const parsed = parsedPayload(payload);
  const commentId = typeof parsed?.commentId === "string" && parsed.commentId.trim()
    ? parsed.commentId
    : null;
  const rawRequest = parsed?.permissionRequest;
  if (!rawRequest || typeof rawRequest !== "object") {
    return { commentId, permissionRequest: null, raisedAt: null };
  }
  const request = rawRequest as Record<string, unknown>;
  if (!isBlockerPermissionKind(request.kind) || typeof request.scope !== "string" || !request.scope.trim()) {
    return { commentId, permissionRequest: null, raisedAt: null };
  }
  return {
    commentId,
    permissionRequest: {
      kind: request.kind,
      scope: request.scope.trim(),
      taskKey: typeof request.taskKey === "string" ? request.taskKey : null,
      taskBranch: typeof request.taskBranch === "string" ? request.taskBranch : null,
      epicBranch: typeof request.epicBranch === "string" ? request.epicBranch : null,
    },
    raisedAt: null,
  };
}

/** Resolve each task's active blocker and the exact comment that raised it. */
export function activeFormalBlockersByTask(
  newestFirstRows: readonly TaskActivityKindRow[],
  legacyBlockerComments: readonly TaskBlockerCommentRow[] = [],
) {
  const resolved = new Set<string>();
  const active = new Map<string, ActiveFormalBlocker>();

  for (const row of newestFirstRows) {
    if (!row.taskId || resolved.has(row.taskId) || !FORMAL_BLOCKER_KINDS.has(row.kind)) {
      continue;
    }
    resolved.add(row.taskId);
    if (row.kind !== "task.blocker.cleared") {
      const metadata = blockerMetadataFromPayload(row.payload);
      if (!metadata.commentId && row.createdAt != null) {
        const activityTime = timestamp(row.createdAt);
        const legacyComment = legacyBlockerComments.find((comment) => (
          comment.taskId === row.taskId &&
          Math.abs(timestamp(comment.createdAt) - activityTime) <= 1_000
        ));
        active.set(row.taskId, {
          ...metadata,
          commentId: legacyComment?.id ?? null,
          raisedAt: row.createdAt ?? null,
        });
      } else {
        active.set(row.taskId, { ...metadata, raisedAt: row.createdAt ?? null });
      }
    }
  }

  return active;
}

export function blockerPermissionGrantForComment(
  newestFirstRows: readonly Pick<TaskActivityKindRow, "kind" | "payload" | "createdAt">[],
  blockerCommentId: string,
) {
  for (const row of newestFirstRows) {
    if (row.kind !== "task.blocker.permission.granted") continue;
    const parsed = parsedPayload(row.payload);
    if (parsed?.blockerCommentId === blockerCommentId) {
      return {
        authorizationCommentId: typeof parsed.authorizationCommentId === "string"
          ? parsed.authorizationCommentId
          : null,
        grantedAt: row.createdAt ?? null,
      };
    }
  }
  return null;
}

/** Resolve active blockers together with the permission round attached to them. */
export function activeFormalBlockerStatesByTask(
  newestFirstRows: readonly TaskActivityKindRow[],
  legacyBlockerComments: readonly TaskBlockerCommentRow[] = [],
) {
  const active = activeFormalBlockersByTask(newestFirstRows, legacyBlockerComments);
  const states = new Map<string, ActiveFormalBlockerState>();
  for (const [taskId, blocker] of active) {
    states.set(taskId, {
      ...blocker,
      permissionGrant: blocker.commentId
        ? blockerPermissionGrantForComment(newestFirstRows, blocker.commentId)
        : null,
    });
  }
  return states;
}

/**
 * A granted permission round is no longer waiting on a human. It remains
 * visible until the authorized operation settles, but execution recovery must
 * keep waking the assignee so the capability is actually used.
 */
export function formalBlockerNeedsExternalInput(blocker: ActiveFormalBlockerState) {
  return !blocker.permissionRequest || !blocker.permissionGrant?.authorizationCommentId;
}

export function activeCheckpointBlockerUsesAuthorization(
  blocker: ActiveFormalBlockerState | null | undefined,
  authorizationCommentId: string,
) {
  return Boolean(
    blocker?.commentId &&
    blocker.permissionRequest?.kind === "publish_checkpoint" &&
    blocker.permissionGrant?.authorizationCommentId === authorizationCommentId,
  );
}

/**
 * Resolve the current formal-blocker state from task activity ordered newest
 * first. `alertReporter` cannot be used for this because repository and
 * administrative alerts share that broader flag.
 */
export function activeFormalBlockerTaskIds(
  newestFirstRows: readonly TaskActivityKindRow[],
) {
  return new Set(activeFormalBlockersByTask(newestFirstRows).keys());
}
