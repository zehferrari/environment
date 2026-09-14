type CheckpointAuthorizationTextArgs = {
  body: string;
  taskKey: string | null;
  taskBranch: string;
  epicBranch: string | null;
};

export type CheckpointAuthorizationValidation =
  | { ok: true }
  | { ok: false; reason: string };

function normalized(value: string) {
  return value.trim().toLocaleLowerCase();
}

/**
 * A normal owner comment is not a publication capability. Checkpoint
 * authorization must explicitly name the operation, the task source, and the
 * publication branch that PM is allowed to publish/deploy (the task branch
 * for standalone work, or the Epic integration branch for an Epic child).
 */
export function validateCheckpointAuthorizationText(
  args: CheckpointAuthorizationTextArgs,
): CheckpointAuthorizationValidation {
  const body = normalized(args.body);
  const taskMarkers = [args.taskKey, args.taskBranch]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalized);

  if (/\b(?:do\s+not|don't|not|never)\s+authori[sz](?:e|ed|ation)\b/.test(body)) {
    return { ok: false, reason: "The owner comment explicitly negates authorization." };
  }
  const positiveAuthorization =
    /\b(?:i|we)\s+(?:(?:explicitly|hereby)\s+)*authori[sz]e\b/.test(body) ||
    /\b(?:you|pm|mission control)\s+(?:is|are)\s+(?:(?:explicitly|hereby)\s+)*authori[sz]ed\b/.test(body) ||
    /\bauthori[sz]ation\s+(?:is\s+)?(?:(?:explicitly|hereby)\s+)*granted\b/.test(body) ||
    /(?:^|[.!?]\s+)authori[sz]ed\b/.test(body);
  if (!positiveAuthorization) {
    return { ok: false, reason: "The owner comment does not contain a positive explicit authorization statement." };
  }
  if (!/\bcheckpoint\b/.test(body)) {
    return { ok: false, reason: "The owner comment does not explicitly authorize a checkpoint." };
  }
  if (!/\b(?:publish|push|merge|deploy)(?:ed|ing|ment)?\b/.test(body)) {
    return { ok: false, reason: "The owner comment does not authorize publication or deployment." };
  }
  if (!taskMarkers.some((marker) => body.includes(marker))) {
    return { ok: false, reason: "The owner comment does not name this task key or task branch." };
  }
  if (!body.includes(normalized(args.epicBranch ?? args.taskBranch))) {
    return { ok: false, reason: "The owner comment does not name the target publication branch." };
  }
  return { ok: true };
}

export function activityPayloadUsesCheckpointAuthorization(
  payload: string | null,
  authorizationCommentId: string,
) {
  if (!payload) return false;
  try {
    const parsed = JSON.parse(payload) as { authorizationCommentId?: unknown };
    return parsed.authorizationCommentId === authorizationCommentId;
  } catch {
    return false;
  }
}
