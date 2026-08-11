// ENV-119: Structured Action Plan persistence.
//
// Replaces parsing Markdown from AgentChatMessage.body. Action plans are
// received as a dedicated JSON payload on the PM channel reply endpoint,
// validated, and persisted as ActionPlan + ActionPlanStep rows. Markdown
// body remains in AgentChatMessage as presentation only.
//
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { createSubTaskItem } from "@/lib/tasks/subtasks";

// ── Types ──────────────────────────────────────────────────────────────

export interface ActionPlanStepInput {
  id: string;
  title: string;
  acceptanceCriteria: string[];
  kind: "sequential" | "parallel";
  assigneeId?: string | null;
}

export interface ActionPlanInput {
  summary: string;
  steps: ActionPlanStepInput[];
}

export interface PersistedActionPlan {
  id: string;
  taskId: string;
  summary: string;
  version: number;
  status: string;
  authorId: string | null;
  sourceRunId: string | null;
  sourceMessageId: string | null;
  contentHash: string;
  approvedOn: Date | null;
  steps: Array<{
    id: string;
    stepId: string;
    title: string;
    acceptanceCriteria: string[];
    kind: "sequential" | "parallel";
    assigneeId: string | null;
    rank: number;
  }>;
}

// ── Validation ─────────────────────────────────────────────────────────

export type ActionPlanValidationError = {
  field: string;
  message: string;
};

export function validateActionPlanInput(
  input: unknown,
): ActionPlanInput | { errors: ActionPlanValidationError[] } {
  const errors: ActionPlanValidationError[] = [];

  if (!input || typeof input !== "object") {
    return { errors: [{ field: "actionPlan", message: "actionPlan must be an object" }] };
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) {
    errors.push({ field: "summary", message: "summary is required and must be a non-empty string" });
  }
  if (raw.summary && typeof raw.summary === "string" && raw.summary.length > 2000) {
    errors.push({ field: "summary", message: "summary must be <= 2000 characters" });
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    errors.push({ field: "steps", message: "steps is required and must be a non-empty array" });
    return { errors };
  }
  if (raw.steps.length > 20) {
    errors.push({ field: "steps", message: "steps must have <= 20 items" });
  }

  const seenStepIds = new Set<string>();
  const seenStepTitles = new Set<string>();
  const validatedSteps: ActionPlanStepInput[] = [];

  for (let i = 0; i < (raw.steps as unknown[]).length; i++) {
    const step = (raw.steps as unknown[])[i] as Record<string, unknown>;
    const prefix = `steps[${i}]`;

    if (!step || typeof step !== "object") {
      errors.push({ field: prefix, message: "step must be an object" });
      continue;
    }

    if (typeof step.id !== "string" || step.id.trim().length === 0) {
      errors.push({ field: `${prefix}.id`, message: "id is required and must be a non-empty string" });
      continue;
    }
    if (step.id.length > 100) {
      errors.push({ field: `${prefix}.id`, message: "id must be <= 100 characters" });
    }
    const stepId = step.id.trim();
    if (seenStepIds.has(stepId)) {
      errors.push({ field: `${prefix}.id`, message: `duplicate step id: "${stepId}"` });
      continue;
    }
    seenStepIds.add(stepId);

    if (typeof step.title !== "string" || step.title.trim().length === 0) {
      errors.push({ field: `${prefix}.title`, message: "title is required and must be a non-empty string" });
      continue;
    }
    if (step.title.length > 500) {
      errors.push({ field: `${prefix}.title`, message: "title must be <= 500 characters" });
    }
    const normalizedTitle = step.title.trim().toLocaleLowerCase();
    if (seenStepTitles.has(normalizedTitle)) {
      errors.push({ field: `${prefix}.title`, message: `duplicate step title: "${step.title.trim()}"` });
    }
    seenStepTitles.add(normalizedTitle);

    if (!Array.isArray(step.acceptanceCriteria)) {
      errors.push({ field: `${prefix}.acceptanceCriteria`, message: "acceptanceCriteria must be an array of strings" });
    } else {
      for (let j = 0; j < step.acceptanceCriteria.length; j++) {
        const crit = step.acceptanceCriteria[j];
        if (typeof crit !== "string" || crit.trim().length === 0) {
          errors.push({ field: `${prefix}.acceptanceCriteria[${j}]`, message: "each criterion must be a non-empty string" });
        }
      }
    }

    if (step.kind !== "sequential" && step.kind !== "parallel") {
      errors.push({ field: `${prefix}.kind`, message: 'kind must be "sequential" or "parallel"' });
    }

    if (step.assigneeId !== undefined && step.assigneeId !== null) {
      if (typeof step.assigneeId !== "string" || step.assigneeId.trim().length === 0) {
        errors.push({ field: `${prefix}.assigneeId`, message: "assigneeId must be a string or null" });
      }
    }

    validatedSteps.push({
      id: stepId,
      title: step.title.trim(),
      acceptanceCriteria: Array.isArray(step.acceptanceCriteria)
        ? step.acceptanceCriteria.filter((c) => typeof c === "string" && c.trim().length > 0).map((c) => c.trim())
        : [],
      kind: step.kind === "parallel" ? "parallel" : "sequential",
      assigneeId: typeof step.assigneeId === "string" && step.assigneeId.trim() ? step.assigneeId.trim() : null,
    });
  }

  if (errors.length > 0) return { errors };
  return { summary: (raw.summary as string).trim(), steps: validatedSteps };
}

// ── Persist structured action plan ──────────────────────────────────────

type TxClient = Prisma.TransactionClient | typeof db;

export async function persistActionPlan(args: {
  taskId: string;
  input: ActionPlanInput;
  authorId?: string | null;
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
  client?: TxClient;
}): Promise<PersistedActionPlan> {
  const client = args.client ?? db;
  const { summary, steps } = args.input;

  // Check for existing plan (idempotent — replace if exists and unapproved)
  const existing = await client.actionPlan.findUnique({
    where: { taskId: args.taskId },
    select: { id: true, approvedOn: true, version: true },
  });
  if (existing?.approvedOn) {
    throw new Error("Action plan already approved — cannot replace");
  }

  // Verify assigneeIds reference active principals of the task's project
  const assigneeIds = steps.filter((s) => s.assigneeId).map((s) => s.assigneeId!) as string[];
  if (assigneeIds.length > 0) {
    const task = await client.task.findUnique({
      where: { id: args.taskId },
      select: { projectId: true },
    });
    if (!task) {
      throw new Error(`Task not found: ${args.taskId}`);
    }
    // Look up active project members (principals) for the task's project
    const members = await client.projectMember.findMany({
      where: {
        projectId: task.projectId,
        role: { not: "inactive" },
      },
      select: { userId: true },
    });
    const validPrincipalIds = new Set(members.map((m) => m.userId));
    for (const id of assigneeIds) {
      if (!validPrincipalIds.has(id)) {
        throw new Error(
          `Invalid assigneeId: ${id} — not an active principal of the task's project`,
        );
      }
    }
  }

  const version = (existing?.version ?? 0) + 1;
  const contentHash = createHash("sha256").update(JSON.stringify({ summary, steps })).digest("hex");
  const stepRows = steps.map((step, index) => ({
    stepId: step.id,
    title: step.title,
    acceptanceCriteria: JSON.stringify(step.acceptanceCriteria),
    kind: step.kind,
    assigneeId: step.assigneeId ?? null,
    rank: index + 1,
  }));

  // Perform writes directly on the supplied client. When a TransactionClient
  // is passed (from an outer $transaction), we must NOT call $transaction on
  // it — Prisma TransactionClient has no $transaction method. When no client
  // is supplied, we use the default db and wrap in a transaction.
  const writeTarget = args.client ?? db;

  async function doWrites(tx: Prisma.TransactionClient | typeof db) {
    if (existing) {
      await tx.actionPlanStep.deleteMany({ where: { actionPlanId: existing.id } });
      const updated = await tx.actionPlan.update({
        where: { id: existing.id },
        data: {
          summary,
          version,
          status: "draft",
          authorId: args.authorId ?? null,
          sourceRunId: args.sourceRunId ?? null,
          sourceMessageId: args.sourceMessageId ?? null,
          contentHash,
          approvedOn: null,
          approvedById: null,
          steps: { create: stepRows },
        },
        include: { steps: { orderBy: { rank: "asc" } } },
      });
      await tx.actionPlanRevision.create({
        data: {
          actionPlanId: updated.id,
          taskId: args.taskId,
          version,
          summary,
          status: "draft",
          authorId: args.authorId ?? null,
          sourceRunId: args.sourceRunId ?? null,
          sourceMessageId: args.sourceMessageId ?? null,
          contentHash,
          steps: { create: stepRows },
        },
      });
      return updated;
    }

    const created = await tx.actionPlan.create({
      data: {
        taskId: args.taskId,
        summary,
        version,
        status: "draft",
        authorId: args.authorId ?? null,
        sourceRunId: args.sourceRunId ?? null,
        sourceMessageId: args.sourceMessageId ?? null,
        contentHash,
        steps: { create: stepRows },
      },
      include: { steps: { orderBy: { rank: "asc" } } },
    });
    await tx.actionPlanRevision.create({
      data: {
        actionPlanId: created.id,
        taskId: args.taskId,
        version,
        summary,
        status: "draft",
        authorId: args.authorId ?? null,
        sourceRunId: args.sourceRunId ?? null,
        sourceMessageId: args.sourceMessageId ?? null,
        contentHash,
        steps: { create: stepRows },
      },
    });

    return created;
  }

  const plan = args.client
    ? await doWrites(args.client)
    : await db.$transaction(async (tx: Prisma.TransactionClient) => doWrites(tx));

  return {
    id: plan.id,
    taskId: plan.taskId,
    summary: plan.summary,
    version: plan.version,
    status: plan.status,
    authorId: plan.authorId,
    sourceRunId: plan.sourceRunId,
    sourceMessageId: plan.sourceMessageId,
    contentHash: plan.contentHash,
    approvedOn: plan.approvedOn,
    steps: plan.steps.map((s) => ({
      id: s.id,
      stepId: s.stepId,
      title: s.title,
      acceptanceCriteria: parseAcceptanceCriteria(s.acceptanceCriteria),
      kind: s.kind,
      assigneeId: s.assigneeId,
      rank: s.rank,
    })),
  };
}

// ── Read ────────────────────────────────────────────────────────────────

export async function getActionPlanForTask(taskId: string): Promise<PersistedActionPlan | null> {
  const plan = await db.actionPlan.findUnique({
    where: { taskId },
    include: { steps: { orderBy: { rank: "asc" } } },
  });
  if (!plan) return null;
  return {
    id: plan.id,
    taskId: plan.taskId,
    summary: plan.summary,
    version: plan.version,
    status: plan.status,
    authorId: plan.authorId,
    sourceRunId: plan.sourceRunId,
    sourceMessageId: plan.sourceMessageId,
    contentHash: plan.contentHash,
    approvedOn: plan.approvedOn,
    steps: plan.steps.map((s) => ({
      id: s.id,
      stepId: s.stepId,
      title: s.title,
      acceptanceCriteria: parseAcceptanceCriteria(s.acceptanceCriteria),
      kind: s.kind,
      assigneeId: s.assigneeId,
      rank: s.rank,
    })),
  };
}

// ── Approval: checklist + delegatable subtasks ──────────────────────────

export async function createChecklistAndDelegatableTasksFromPlan(args: {
  taskId: string;
  approvedAt: Date;
  approvedById: string;
  client?: TxClient;
}): Promise<{ checklistCreated: number; delegatableCreated: number; reason: string }> {
  const client = args.client ?? db;
  const plan = await client.actionPlan.findUnique({
    where: { taskId: args.taskId },
    include: { steps: { orderBy: { rank: "asc" } } },
  });
  if (!plan) return { checklistCreated: 0, delegatableCreated: 0, reason: "no_plan" };

  let checklistCreated = 0;
  let delegatableCreated = 0;

  for (const step of plan.steps) {
    // A planning turn from an older client may already have created the exact
    // checklist row before plan approval. Adopt that unlinked row instead of
    // duplicating it when the structured plan is approved. New clients are
    // blocked from pre-approval checklist writes, but this keeps recovery of
    // existing tasks lossless.
    const existingUnlinked = await client.subTask.findFirst({
      where: {
        taskId: args.taskId,
        kind: "implementation",
        actionPlanStepId: null,
        text: step.title,
      },
      select: { id: true },
    });
    if (existingUnlinked) {
      await client.subTask.update({
        where: { id: existingUnlinked.id },
        data: { actionPlanStepId: step.id },
      });
    } else {
      const checklistItem = await createSubTaskItem({
        taskId: args.taskId,
        text: step.title,
        actorUserId: args.approvedById,
        actionPlanStepId: step.id,
        client,
      });
      if (checklistItem?.created) checklistCreated++;
    }

    // Parallel steps are independently delegatable. An optional assignee
    // chooses the initial owner; a parallel step without one is still a real
    // unassigned child task. Sequential steps never become child tasks merely
    // because an assignee was accidentally supplied.
    if (step.kind === "parallel") {
      // Check if a child task already exists for this step (idempotent)
      const existingChild = await client.task.findFirst({
        where: {
          parentTaskId: args.taskId,
          title: step.title,
          deletedAt: null,
        },
        select: { id: true },
        take: 1,
      });
      if (!existingChild) {
        const parent = await client.task.findUnique({
          where: { id: args.taskId },
          select: { projectId: true, epicId: true },
        });
        if (parent) {
          await client.task.create({
            data: {
              projectId: parent.projectId,
              epicId: parent.epicId,
              parentTaskId: args.taskId,
              title: step.title,
              status: "To Do",
              assigneeId: step.assigneeId ?? null,
              description: `Delegated step from parent task.\n\nAcceptance criteria:\n${parseAcceptanceCriteria(step.acceptanceCriteria).map((c) => `- ${c}`).join("\n")}`,
            },
          });
          delegatableCreated++;
        }
      }
    }
  }

  return {
    checklistCreated,
    delegatableCreated,
    reason: checklistCreated === 0 && delegatableCreated === 0 ? "already_exists" : "created",
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function parseAcceptanceCriteria(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}
