export const DEPLOYMENT_STATUSES = [
  "Not Required",
  "Deployment Approved",
  "Successfully Deployed",
  "Deployment Error",
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export function isDeploymentStatus(value: unknown): value is DeploymentStatus {
  return typeof value === "string" && (DEPLOYMENT_STATUSES as readonly string[]).includes(value);
}

export function deploymentStatusIcon(status: string | null | undefined) {
  switch (status) {
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

export function canShowDeploymentForTask(task: { epicId?: string | null; parentTaskId?: string | null }) {
  return task.parentTaskId == null;
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
  if (args.to === "Deployment Approved" && args.actor.kind === "agent") {
    return { ok: false as const, message: "Agents cannot set Deployment Approved." };
  }
  if (["Successfully Deployed", "Deployment Error"].includes(args.to)) {
    const isMonitorAgent = args.actor.kind === "agent" && args.actorAgentRole === "monitor";
    if (!isMonitorAgent) {
      return { ok: false as const, message: "Only the Monitor Agent can set deployment result statuses." };
    }
  }
  return { ok: true as const };
}
