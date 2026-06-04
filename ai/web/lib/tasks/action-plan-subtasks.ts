import { db } from "@/lib/db";
import { allocateWorkItemKey } from "@/lib/work-items/keys";

const MAX_AUTO_SUBTASKS = 8;
const STEP_LINE_RE = /^\s*(?:[-*]\s+|\d+[.)]\s+|\[[ xX]\]\s+)(.+)$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const ACCEPTED_STEP_SECTION_RE = /\b(?:deliverables?|implementation\s+steps?|execution\s+steps?|work\s+plan|checklist|sub-?tasks?|milestones?)\b/i;
const IGNORED_STEP_RE = /^(?:all\s+commits?\b|commits?\s+(?:prefixed|must)|waiting\s+on\b|out\s+of\s+scope\b|blocked\b)/i;

function cleanStepText(value: string) {
  return value
    .replace(/\[[ xX]\]\s*/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,\s]+$/g, "");
}

function headingText(line: string) {
  const markdownHeading = line.match(HEADING_RE);
  if (markdownHeading) return cleanStepText(markdownHeading[1]);
  const boldHeading = line.match(/^\s*\*\*(.+?)\*\*\s*:?\s*$/);
  if (boldHeading) return cleanStepText(boldHeading[1]);
  return null;
}

function isAcceptedStepSection(title: string) {
  return ACCEPTED_STEP_SECTION_RE.test(title);
}

export function extractActionPlanSteps(body: string) {
  const withoutCode = body.replace(/```[\s\S]*?```/g, "");
  const steps: string[] = [];
  let inStepSection = false;

  for (const line of withoutCode.split("\n")) {
    const heading = headingText(line);
    if (heading) {
      inStepSection = isAcceptedStepSection(heading);
      continue;
    }
    if (!inStepSection) continue;

    const match = line.match(STEP_LINE_RE);
    if (!match) continue;
    const text = cleanStepText(match[1]);
    if (text.length < 8 || text.length > 180) continue;
    if (/^(none|n\/a|no blockers?|no changes?)$/i.test(text)) continue;
    if (IGNORED_STEP_RE.test(text)) continue;
    if (!steps.some((existing) => existing.toLowerCase() === text.toLowerCase())) {
      steps.push(text);
    }
    if (steps.length >= MAX_AUTO_SUBTASKS) break;
  }
  return steps;
}

export async function createActionPlanSubtasksForTask(args: {
  taskId: string;
  approvedAt: Date;
  approvedById: string;
}) {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      epicId: true,
      parentTaskId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      approvedOn: true,
      branchName: true,
      commitPrefix: true,
      subtasks: { where: { deletedAt: null }, select: { id: true }, take: 1 },
    },
  });
  if (!task || task.parentTaskId !== null || task.subtasks.length > 0 || !task.assigneeId || !task.approvedOn) {
    return { created: 0, reason: "not_applicable" as const };
  }

  const latestPlan = await db.agentChatMessage.findFirst({
    where: {
      taskId: task.id,
      archiveId: null,
      deletedAt: null,
      originChannel: "chat",
      body: { not: { startsWith: "PM workflow notification for @" } },
      ...(task.assigneeId ? { senderUserId: task.assigneeId } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, body: true },
  });
  if (!latestPlan) return { created: 0, reason: "no_plan" as const };

  const steps = extractActionPlanSteps(latestPlan.body);
  if (steps.length === 0) return { created: 0, reason: "no_steps" as const };

  const maxRank = await db.task.aggregate({
    where: { projectId: task.projectId, status: "Backlog", archivedAt: null, deletedAt: null },
    _max: { rank: true },
  });
  const baseRank = maxRank._max.rank ?? 0;

  await db.$transaction(async (tx) => {
    for (let index = 0; index < steps.length; index += 1) {
      const title = `${index + 1}. ${steps[index]}`;
      const child = await tx.task.create({
        data: {
          projectId: task.projectId,
          workItemKey: await allocateWorkItemKey(task.projectId, tx),
          epicId: task.epicId,
          parentTaskId: task.id,
          title,
          status: "Backlog",
          rank: baseRank + index + 1,
          statusChangedAt: args.approvedAt,
          assigneeId: null,
          actingManagerId: null,
          reporterId: task.reporterId,
          approvedOn: args.approvedAt,
          approvedById: args.approvedById,
          branchName: task.branchName,
          commitPrefix: task.commitPrefix,
        },
        select: { id: true },
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: child.id,
          userId: task.assigneeId,
          kind: "task.create",
          payload: JSON.stringify({
            title,
            parentTaskId: task.id,
            parentTitle: task.title,
            source: "approved_action_plan",
            createdFromAssigneePlan: true,
            workflowSuppressed: true,
            planMessageId: latestPlan.id,
          }),
        },
      });
    }
  });

  return { created: steps.length, reason: "created" as const };
}
