// The deployment field is the optional, post-`Done` "ship it" lane — separate
// from the main workflow status. It applies only to repo-backed projects, on
// standalone tasks (no epic parent) and epics. "Ready to Deploy" is the human
// opt-in that (for epics) kicks off the pre-merge whole-contribution review.
export const DEPLOYMENT_STATUSES = [
  "Not Required",
  "Ready to Deploy",
  "Deployment Approved",
  "Successfully Deployed",
  "Deployment Error",
] as const;

// DeploymentPullRequest ROW statuses. The deployment monitor
// (lib/deploy/monitor.ts) writes `open`, `local_changes_pending_approval`,
// then exactly one terminal value per row. The Development tab renders from
// this vocabulary — writer and reader must both import from here.
export const DEPLOYMENT_PR_OPEN = "open";
export const DEPLOYMENT_PR_LOCAL_CHANGES_PENDING = "local_changes_pending_approval";
export const DEPLOYMENT_PR_TERMINAL_STATUSES = [
  "deployed",
  "deployment_error",
  "declined",
  "pipeline_failed",
] as const;
export type DeploymentPrTerminalStatus = (typeof DEPLOYMENT_PR_TERMINAL_STATUSES)[number];

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export function isDeploymentStatus(value: unknown): value is DeploymentStatus {
  return typeof value === "string" && (DEPLOYMENT_STATUSES as readonly string[]).includes(value);
}

export function deploymentStatusIcon(status: string | null | undefined) {
  switch (status) {
    case "Ready to Deploy":
      return "🚀";
    case "Deployment Approved":
      return "🟠";
    case "Successfully Deployed":
      return "🟢";
    case "Deployment Error":
      return "🔴";
    default:
      return "—";
  }
}

// Deployment applies only to standalone tasks — a task under an epic never
// carries its own deploy state; the epic owns the whole implementation's
// deploy gate.
export function canShowDeploymentForTask(task: { epicId?: string | null; parentTaskId?: string | null }) {
  return task.epicId == null && task.parentTaskId == null;
}

export function checkDeploymentStatusWrite(args: {
  actor: { kind: "human" | "agent" };
  actorAgentRole?: string | null;
  from: string;
  to: string;
}) {
  if (!isDeploymentStatus(args.to)) {
    return { ok: false as const, message: `Unknown deployment status: ${String(args.to)}` };
  }
  if (args.to === args.from) return { ok: true as const };
  // Browser-session human edits are authoritative: if the UI exposes the
  // deployment status select, the server persists the chosen value. Agent
  // automation remains constrained below so only the monitor agent can write
  // deployment result statuses.
  if (args.actor.kind === "human") return { ok: true as const };
  if ((args.to === "Deployment Approved" || args.to === "Ready to Deploy") && args.actor.kind === "agent") {
    return { ok: false as const, message: "Agents cannot opt work into deployment." };
  }
  if (["Successfully Deployed", "Deployment Error"].includes(args.to)) {
    const isMonitorAgent = args.actor.kind === "agent" && args.actorAgentRole === "monitor";
    if (!isMonitorAgent) {
      return { ok: false as const, message: "Only the Monitor Agent can set deployment result statuses." };
    }
  }
  return { ok: true as const };
}
