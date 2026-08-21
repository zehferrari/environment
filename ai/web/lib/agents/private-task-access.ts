import { db } from "@/lib/db";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { orchestratorV2MutationProjects } from "@/lib/tasks/orchestrator/flags";
import { ENGINE_ORCHESTRATOR_V2 } from "@/lib/tasks/orchestrator/ownership";

function parseExplicitProjectAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => Boolean(value) && value !== "*"),
  );
}

/**
 * Private task access is an empty-default, exact-project capability. A
 * wildcard is deliberately ignored: private data must never become visible
 * through a broad rollout switch.
 */
export function privateTaskAgentProjects(): Set<string> {
  return parseExplicitProjectAllowlist(process.env.PM_PRIVATE_TASK_AGENT_PROJECTS);
}

/**
 * Both explicit allowlists must name the project. The effectful admission
 * wildcard does not satisfy this fence because private agent access is only
 * intended for a deliberately named internal canary cohort.
 */
export function privateTaskAgentAccessEnabledForProject(projectSlug: string): boolean {
  return privateTaskAgentProjects().has(projectSlug)
    && orchestratorV2MutationProjects().has(projectSlug);
}

type TaskAccessRow = {
  archivedAt: Date | null;
  deletedAt: Date | null;
  private: boolean;
  parentTaskId: string | null;
  epicId: string | null;
  workflowEngine: string;
  assigneeId: string | null;
  actingManagerId: string | null;
  reporterId: string | null;
  project: { slug: string };
  epic: {
    status: string;
    private: boolean;
    actingManagerId: string | null;
  } | null;
  parent: {
    private: boolean;
    epic: { private: boolean } | null;
  } | null;
};

export type AgentTaskAccess = {
  allowed: boolean;
  visibility: "public" | "private-agent" | "denied";
  attachmentsAllowed: boolean;
};

function effectivelyPublic(task: TaskAccessRow): boolean {
  return !task.archivedAt
    && !task.deletedAt
    && !task.private
    && !task.epic?.private
    && !task.parent?.private
    && !task.parent?.epic?.private;
}

export function evaluateAgentTaskAccess(
  task: TaskAccessRow | null | undefined,
  agentUserId: string | null | undefined,
): AgentTaskAccess {
  if (!task || task.archivedAt || task.deletedAt) {
    return { allowed: false, visibility: "denied", attachmentsAllowed: false };
  }
  if (effectivelyPublic(task)) {
    return { allowed: true, visibility: "public", attachmentsAllowed: true };
  }

  // Keep the exception intentionally smaller than general private-task
  // visibility: only an explicitly admitted, top-level, non-Epic task can use
  // it. Generic project/Epic/search/proposal/attachment surfaces stay private.
  if (
    !agentUserId
    || !task.private
    || task.parentTaskId !== null
    || task.epicId !== null
    || task.workflowEngine !== ENGINE_ORCHESTRATOR_V2
    || !privateTaskAgentAccessEnabledForProject(task.project.slug)
  ) {
    return { allowed: false, visibility: "denied", attachmentsAllowed: false };
  }

  const reviewerId = resolveReviewOwnerId({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic
      ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId }
      : null,
  });
  const roleAllowed = agentUserId === task.assigneeId || agentUserId === reviewerId;
  return roleAllowed
    ? { allowed: true, visibility: "private-agent", attachmentsAllowed: false }
    : { allowed: false, visibility: "denied", attachmentsAllowed: false };
}

export async function resolveAgentTaskAccess(args: {
  taskId: string;
  agentSlug?: string | null;
  agentUserId?: string | null;
}): Promise<AgentTaskAccess> {
  const [task, agent] = await Promise.all([
    db.task.findUnique({
      where: { id: args.taskId },
      select: {
        archivedAt: true,
        deletedAt: true,
        private: true,
        parentTaskId: true,
        epicId: true,
        workflowEngine: true,
        assigneeId: true,
        actingManagerId: true,
        reporterId: true,
        project: { select: { slug: true } },
        epic: { select: { status: true, private: true, actingManagerId: true } },
        parent: { select: { private: true, epic: { select: { private: true } } } },
      },
    }),
    args.agentUserId || !args.agentSlug
      ? Promise.resolve(null)
      : db.agent.findUnique({
          where: { slug: args.agentSlug },
          select: {
            deactivatedAt: true,
            user: { select: { id: true, status: true } },
          },
        }),
  ]);
  const agentUserId = args.agentUserId
    ?? (
      agent && !agent.deactivatedAt && agent.user?.status === "active"
        ? agent.user.id
        : null
    );
  return evaluateAgentTaskAccess(task, agentUserId);
}
