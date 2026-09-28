import type { IntentExecutor } from "./types";

/** Reviewer judgment about phase and responsibility, never completion or a production grant. */
export const deferAcceptanceCheckExecutor: IntentExecutor<"defer_acceptance_check"> = async context => {
  const { state, command, tx, decision } = context;
  const { blockerCommentId, subtaskId, actionPlanId, actionPlanVersion, rationale } = command.payload;
  const plan = state.actionPlan;
  const blocker = state.activeBlocker;
  if (!plan || plan.status !== "approved" || plan.id !== actionPlanId || plan.version !== actionPlanVersion
    || !blocker || blocker.commentId !== blockerCommentId || blocker.override || blocker.permissionRequest
    || !["decision", "person"].includes(blocker.report?.blockedOn ?? "")) {
    return { status: "stale", domainCode: "cycle_mismatch", reason: "Refresh the approved plan and active acceptance-check blocker before deciding." };
  }
  if (!await tx.comment.findFirst({ where: { id: blockerCommentId, taskId: state.id, deletedAt: null }, select: { id: true } })) return { status: "stale", domainCode: "cycle_mismatch", reason: "The blocker comment was deleted." };
  const item = await tx.subTask.findFirst({ where: { id: subtaskId, taskId: state.id, kind: "implementation", completedAt: null }, include: { actionPlanStep: true } });
  if (!item || item.actionPlanStep?.actionPlanId !== plan.id) {
    return { status: "invalid", domainCode: "invalid_payload", reason: "Only an open check linked to the current approved plan may be deferred." };
  }
  const duplicate = await tx.subTask.findFirst({ where: { taskId: state.id, kind: "review", groupKey: item.groupKey, text: item.text } });
  if (duplicate) return { status: "invalid", domainCode: "invalid_payload", reason: "A matching review check already exists; reconcile it explicitly before deferring." };
  // Moving verification to Review does not make it human work. Preserve an
  // explicit owner requirement; otherwise the independent reviewer (including
  // the Epic manager fallback) owns it unless a human-only check is identified.
  const ownerRequired = item.responsibleActor === "owner" || item.actionPlanStep.responsibleActor === "owner";
  const responsibleActor = command.payload.responsibleActor ?? (ownerRequired ? "owner" : "reviewer");
  if (ownerRequired && responsibleActor !== "owner") return {
    status: "invalid", domainCode: "invalid_payload", reason: "This check explicitly requires owner acceptance. Revise the approved requirement before delegating it.",
  };
  await tx.subTask.update({ where: { id: item.id }, data: {
    kind: "review", responsibleActor, acceptanceGate: item.acceptanceGate,
  } });
  const body = `Deferred to final acceptance, still open: ${item.text}\n\nReviewer assessment: ${rationale}\n\nResponsible actor: ${responsibleActor === "owner" ? "owner" : "task reviewer or acting Epic manager"}. Acceptance remains pending; no production operation or completion is authorized.`;
  const comment = await tx.comment.create({ data: { taskId: state.id, userId: command.actor.id, body,
    authorAgentSlug: command.actor.kind === "agent" ? command.actor.username : null, commentKind: "workflow_action",
    runId: command.executionContext?.pmChannelRunId ?? null }, select: { id: true } });
  await tx.activityLog.create({ data: { projectId: state.projectId, taskId: state.id, userId: command.actor.id,
    kind: "task.acceptance_check.deferred", payload: JSON.stringify({ ...command.payload, responsibleActor, commentId: comment.id, completed: false, cycleId: state.activeCycle?.id }) } });
  await tx.activityLog.create({ data: { projectId: state.projectId, taskId: state.id, userId: command.actor.id,
    kind: "task.blocker.cleared", payload: JSON.stringify({ blockerCommentId, commentId: comment.id, action: "acceptance_check_deferred", resolution: rationale }) } });
  await tx.task.update({ where: { id: state.id }, data: { alertReporter: false } });
  if (state.assigneeId) decision.effects.push({ type: "task_notification", key: `defer-acceptance:${blockerCommentId}:${subtaskId}`, payload: {
    taskId: state.id, targetUserId: state.assigneeId, actor: command.actor, reason: "blocker_response",
    body: `${body}\n\nThe implementation blocker is cleared. Finish any remaining implementation checks and submit ready_for_review. Do not complete or remove the deferred review check.`,
  } });
  return context.helpers.executeDecisionWrites();
};
