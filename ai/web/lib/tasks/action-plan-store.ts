// ENV-119: Structured Action Plan persistence.
//
// Replaces parsing Markdown from AgentChatMessage.body. Action plans are
// received as a dedicated JSON payload on the PM channel reply endpoint,
// validated, and persisted as ActionPlan + ActionPlanStep rows. Markdown
// body remains in AgentChatMessage as presentation only.
//
// The legacy Markdown fallback bridge (extractActionPlanSteps) is kept for
// compatibility with older agent replies that have no structured payload.

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { extractActionPlanSteps } from "@/lib/tasks/action-plan-subtasks";
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
  client?: TxClient;
}): Promise<PersistedActionPlan> {
  const client = args.client ?? db;
  const { summary, steps } = args.input;

  // Check for existing plan (idempotent — replace if exists and unapproved)
  const existing = await client.actionPlan.findUnique({
    where: { taskId: args.taskId },
    select: { id: true, approvedOn: true },
  });
  if (existing?.approvedOn) {
    throw new Error("Action plan already approved — cannot replace");
  }

  // Verify assigneeIds reference active project principals if any are set
  const assigneeIds = steps.filter((s) => s.assigneeId).map((s) => s.assigneeId!) as string[];
  if (assigneeIds.length > 0) {
    const validAssignees = await client.user.findMany({
      where: { id: { in: assigneeIds }, status: "active" },
      select: { id: true },
    });
    const validIds = new Set(validAssignees.map((u) => u.id));
    for (const id of assigneeIds) {
      if (!validIds.has(id)) {
        throw new Error(`Invalid assigneeId: ${id} — not an active user`);
      }
    }
  }

  const txClient = args.client ?? db;
  const plan = await (txClient as typeof db).$transaction(async (tx: Prisma.TransactionClient) => {
    // Delete existing unapproved plan + steps if present (idempotent replace)
    if (existing) {
      await tx.actionPlanStep.deleteMany({ where: { actionPlanId: existing.id } });
      await tx.actionPlan.delete({ where: { id: existing.id } });
    }

    const created = await tx.actionPlan.create({
      data: {
        taskId: args.taskId,
        summary,
        steps: {
          create: steps.map((step, index) => ({
            stepId: step.id,
            title: step.title,
            acceptanceCriteria: JSON.stringify(step.acceptanceCriteria),
            kind: step.kind,
            assigneeId: step.assigneeId ?? null,
            rank: index + 1,
          })),
        },
      },
      include: { steps: { orderBy: { rank: "asc" } } },
    });

    return created;
  });

  return {
    id: plan.id,
    taskId: plan.taskId,
    summary: plan.summary,
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

// ── Legacy Markdown fallback bridge ─────────────────────────────────────

export async function persistActionPlanFromMarkdown(args: {
  taskId: string;
  body: string;
  client?: TxClient;
}): Promise<PersistedActionPlan | null> {
  const client = args.client ?? db;
  const steps = extractActionPlanSteps(args.body);
  if (steps.length === 0) return null;

  // Check for existing plan
  const existing = await client.actionPlan.findUnique({
    where: { taskId: args.taskId },
    select: { id: true, approvedOn: true },
  });
  if (existing?.approvedOn) return null; // Don't replace approved plans

  return persistActionPlan({
    taskId: args.taskId,
    input: {
      summary: steps.slice(0, 2).join("; "),
      steps: steps.map((title, index) => ({
        id: `legacy-${index + 1}`,
        title,
        acceptanceCriteria: [],
        kind: "sequential" as const,
        assigneeId: null,
      })),
    },
    client,
  });
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

  // Idempotent: if checklist already exists, don't duplicate
  const existingChecklist = await client.subTask.findFirst({
    where: { taskId: args.taskId, kind: "implementation" },
    select: { id: true },
    take: 1,
  });
  const checklistExists = !!existingChecklist;

  let checklistCreated = 0;
  let delegatableCreated = 0;

  for (const step of plan.steps) {
    if (!checklistExists) {
      await createSubTaskItem({
        taskId: args.taskId,
        text: step.title,
        actorUserId: args.approvedById,
        client,
      });
      checklistCreated++;
    }

    // Steps with assigneeId → create independently assignable child PM task
    if (step.assigneeId && !checklistExists) {
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
              assigneeId: step.assigneeId,
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
    reason: checklistExists ? "already_exists" : "created",
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