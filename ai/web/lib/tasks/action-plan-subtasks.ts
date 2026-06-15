import { db } from "@/lib/db";
import { createSubTaskItem } from "@/lib/tasks/subtasks";

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

// On Action Plan approval, seed the task's progress checklist (SubTask rows)
// from the assignee's posted plan — so the board immediately shows how many
// steps remain. These are lightweight checklist items (text only), NOT child
// tasks. No-op if the task already has a checklist, has no assignee, or its
// plan has no parseable steps.
export async function createActionPlanSubtasksForTask(args: {
  taskId: string;
  approvedAt: Date;
  approvedById: string;
}) {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      assigneeId: true,
      approvedOn: true,
      checklist: { select: { id: true }, take: 1 },
    },
  });
  if (!task || task.checklist.length > 0 || !task.assigneeId || !task.approvedOn) {
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

  for (const step of steps) {
    await createSubTaskItem({
      taskId: task.id,
      text: step,
      actorUserId: task.assigneeId,
    });
  }

  return { created: steps.length, reason: "created" as const };
}
