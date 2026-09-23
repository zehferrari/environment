/** A reviewer judges scope; PM fences who, which request, plan and environment. */
export const PERMISSION_ENVIRONMENTS = ["local", "development", "test", "staging", "production", "unknown"] as const;
export type PermissionContext = {
  environment: (typeof PERMISSION_ENVIRONMENTS)[number];
  target: string;
  changesScope: boolean;
  destructive: boolean;
  securitySensitive: boolean;
};
export type PermissionReview = {
  blockerCommentId: string;
  decision: "approve" | "decline" | "escalate";
  rationale: string;
  actionPlanId: string;
  actionPlanVersion: number;
  planStepIds: string[];
};
export function permissionContextFromValue(value: unknown): PermissionContext | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!PERMISSION_ENVIRONMENTS.includes(v.environment as PermissionContext["environment"])
    || typeof v.target !== "string" || !v.target.trim() || v.target.length > 1000
    || typeof v.changesScope !== "boolean" || typeof v.destructive !== "boolean"
    || typeof v.securitySensitive !== "boolean") return null;
  return { environment: v.environment as PermissionContext["environment"], target: v.target.trim(),
    changesScope: v.changesScope, destructive: v.destructive, securitySensitive: v.securitySensitive };
}
export function permissionRequiresOwner(context: PermissionContext | null | undefined): boolean {
  return !context || ["production", "unknown"].includes(context.environment)
    || context.changesScope || context.destructive || context.securitySensitive;
}
export function validatePermissionReview(value: Record<string, unknown>): string | null {
  for (const key of ["blockerCommentId", "rationale", "actionPlanId"]) {
    if (typeof value[key] !== "string" || !(value[key] as string).trim() || (value[key] as string).length > 4000)
      return `${key} must be a non-empty string of at most 4000 characters`;
  }
  if (!["approve", "decline", "escalate"].includes(String(value.decision))) return "Invalid permission decision";
  if (!Number.isInteger(value.actionPlanVersion) || Number(value.actionPlanVersion) < 1) return "Current actionPlanVersion is required";
  if (!Array.isArray(value.planStepIds) || value.planStepIds.length > 20 || value.planStepIds.some(id => typeof id !== "string" || !id.trim())) return "planStepIds must name the relevant approved steps";
  if (value.decision === "approve" && !value.planStepIds.length) return "Approval must cite at least one approved plan step";
  return null;
}

export function permissionReviewForComment(rows: Array<{ kind: string; payload?: string | null }>, commentId: string) {
  for (const row of rows) {
    if (row.kind !== "task.blocker.permission.reviewed") continue;
    try {
      const p = JSON.parse(row.payload ?? "{}");
      if (p.blockerCommentId === commentId && ["approve", "decline", "escalate"].includes(p.decision))
        return { decision: String(p.decision), rationale: String(p.rationale ?? "") };
    } catch { /* Invalid audit rows grant no authority. */ }
  }
  return null;
}
