// ENV-119: Structured Action Plan persistence.
//
// Replaces parsing Markdown from AgentChatMessage.body. Action plans are
// received as a dedicated JSON payload on the PM channel reply endpoint,
// validated, and persisted as ActionPlan + ActionPlanStep rows. Markdown
// body remains in AgentChatMessage as presentation only.
//
import type { Prisma } from "@prisma/client";
import { newTaskWorkflowOwnership } from "@/lib/tasks/orchestrator/ownership";
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
  phase?: "implementation" | "acceptance";
  responsibleActor?: "assignee" | "reviewer" | "owner";
  verificationEnvironment?: string | null;
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
    phase?: string;
    responsibleActor?: string;
    verificationEnvironment?: string | null;
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

    if (step.phase !== undefined && !["implementation", "acceptance"].includes(String(step.phase))) errors.push({ field: `${prefix}.phase`, message: "phase must be implementation or acceptance" });
    if (step.responsibleActor !== undefined && !["assignee", "reviewer", "owner"].includes(String(step.responsibleActor))) errors.push({ field: `${prefix}.responsibleActor`, message: "responsibleActor must be assignee, reviewer or owner" });
    if (step.phase !== "acceptance" && step.responsibleActor && step.responsibleActor !== "assignee") errors.push({ field: `${prefix}.responsibleActor`, message: "Owner/reviewer checks belong to acceptance" });
    if (step.verificationEnvironment != null && (typeof step.verificationEnvironment !== "string" || step.verificationEnvironment.length > 200)) errors.push({ field: `${prefix}.verificationEnvironment`, message: "verificationEnvironment must be a string of at most 200 characters" });
    validatedSteps.push({
      phase: step.phase === "acceptance" ? "acceptance" : "implementation",
      responsibleActor: step.responsibleActor === "owner" ? "owner" : step.responsibleActor === "reviewer" || step.phase === "acceptance" && !step.responsibleActor ? "reviewer" : "assignee",
      verificationEnvironment: typeof step.verificationEnvironment === "string" ? step.verificationEnvironment.trim() || null : null,
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
    select: { id: true, approvedOn: true, version: true, contentHash: true, status: true },
  });
  // Task.approvedOn is the executable approval gate. ActionPlan.approvedOn is
  // its denormalized projection. A repair/reopen transition deliberately
  // clears the task gate before asking for a new revision, so tolerate and
  // heal an older approved projection if a crash or an older deployment left
  // the two rows out of sync. Never replace a plan while the task itself is
  // still approved.
  const task = await client.task.findUnique({
    where: { id: args.taskId },
    select: { projectId: true, approvedOn: true },
  });
  if (!task) {
    throw new Error(`Task not found: ${args.taskId}`);
  }
  if (existing?.approvedOn && task.approvedOn) {
    throw new Error("Action plan already approved — cannot replace");
  }

  // Verify assigneeIds reference active principals of the task's project
  const assigneeIds = steps.filter((s) => s.assigneeId).map((s) => s.assigneeId!) as string[];
  if (assigneeIds.length > 0) {
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
  if (existing?.contentHash === contentHash && !existing.approvedOn) {
    if (existing.status === "revision_required") throw new Error("The requested plan corrections must be addressed before resubmission; unchanged content is not a new revision.");
    const unchanged = await client.actionPlan.findUniqueOrThrow({ where: { id: existing.id }, include: { steps: { orderBy: { rank: "asc" } } } });
    return { ...unchanged, steps: unchanged.steps.map((step) => ({ ...step, acceptanceCriteria: parseAcceptanceCriteria(step.acceptanceCriteria) })) };
  }
  const stepRows = steps.map((step, index) => ({
    stepId: step.id,
    title: step.title,
    acceptanceCriteria: JSON.stringify(step.acceptanceCriteria),
    kind: step.kind,
    phase: step.phase ?? "implementation",
    responsibleActor: step.responsibleActor ?? (step.phase === "acceptance" ? "reviewer" : "assignee"),
    verificationEnvironment: step.verificationEnvironment ?? null,
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
      // Only the latest submitted revision can be approved. Earlier drafts
      // remain immutable history, but are explicitly superseded instead of
      // being swept into a later approval by a broad status update.
      await tx.actionPlanRevision.updateMany({
        where: { actionPlanId: existing.id, status: "draft" },
        data: { status: "superseded" },
      });
      // Retain the old approved requirement fingerprint on its checklist row.
      // Draft edits do not waive or complete any requirement. Approval below
      // reconciles unchanged evidence and explicitly supersedes changed rows.
      const previousSteps = await tx.actionPlanStep.findMany({ where: { actionPlanId: existing.id } });
      for (const step of previousSteps) await tx.subTask.updateMany({
        where: { actionPlanStepId: step.id, planContentHash: null },
        data: { planStepKey: step.stepId, planContentHash: planStepFingerprint(step) },
      });
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
          reviewedAt: null, reviewedById: null, delegatedApproverId: null, delegatedById: null,
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
      rank: s.rank, phase: s.phase, responsibleActor: s.responsibleActor, verificationEnvironment: s.verificationEnvironment,
    })),
  };
}

// A whole-Epic acceptance rejection is a new planning round, not ordinary
// task review feedback. Preserve the approved ActionPlanRevision snapshot, but
// make the mutable current-plan projection non-approvable until the assignee
// submits the focused repair revision.
export async function markActionPlanRevisionRequired(args: {
  taskId: string;
  client?: TxClient;
}): Promise<{ actionPlanId: string | null; version: number | null; changed: boolean }> {
  const client = args.client ?? db;
  const plan = await client.actionPlan.findUnique({
    where: { taskId: args.taskId },
    select: { id: true, version: true, status: true, approvedOn: true, approvedById: true },
  });
  if (!plan) return { actionPlanId: null, version: null, changed: false };
  if (plan.status === "revision_required" && !plan.approvedOn && !plan.approvedById) {
    return { actionPlanId: plan.id, version: plan.version, changed: false };
  }
  await client.actionPlan.update({
    where: { id: plan.id },
    data: { status: "revision_required", approvedOn: null, approvedById: null, reviewedAt: null, reviewedById: null, delegatedApproverId: null, delegatedById: null },
  });
  return { actionPlanId: plan.id, version: plan.version, changed: true };
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

  const taskPolicy = await client.task.findUniqueOrThrow({ where: { id: args.taskId }, select: { epicId: true, projectId: true, project: { select: { ownerAcceptancePolicy: true } } } });
  const oldRows = await client.subTask.findMany({ where: { taskId: args.taskId, planStepKey: { not: null }, kind: { not: "superseded" } } });
  for (const row of oldRows) {
    const matching = plan.steps.find(step => step.stepId === row.planStepKey && planStepFingerprint(step) === row.planContentHash);
    if (matching) continue;
    await client.subTask.update({ where: { id: row.id }, data: { kind: "superseded", groupKey: `superseded:${row.id}`, actionPlanStepId: null, supersededReason: `Replaced by explicitly approved Action Plan revision ${plan.version}` } });
    await client.activityLog.create({ data: { taskId: args.taskId, projectId: taskPolicy.projectId, userId: args.approvedById, kind: "task.subtask.superseded", payload: JSON.stringify({ subTaskId: row.id, planVersion: plan.version, previousRequirementHash: row.planContentHash, completedAt: row.completedAt }) } });
  }
  for (const step of plan.steps) {
    const hash = planStepFingerprint(step);
    const checklistKind = step.phase === "acceptance" ? "review" : "implementation";
    const acceptanceGate = step.responsibleActor === "owner" && taskPolicy.epicId && taskPolicy.project.ownerAcceptancePolicy === "epic_release" ? "epic_release" : "task";
    const unchanged = oldRows.find(row => row.planStepKey === step.stepId && row.planContentHash === hash);
    if (unchanged) {
      await client.subTask.update({ where: { id: unchanged.id }, data: { actionPlanStepId: step.id } });
    } else {
      const checklistItem = await createSubTaskItem({ taskId: args.taskId, text: step.title, kind: checklistKind, actorUserId: args.approvedById, actionPlanStepId: step.id, groupKey: `plan:${plan.version}`, client });
      if (checklistItem) await client.subTask.update({ where: { id: checklistItem.id }, data: { planStepKey: step.stepId, planContentHash: hash, responsibleActor: step.responsibleActor, verificationEnvironment: step.verificationEnvironment, acceptanceGate } });
      if (checklistItem?.created) checklistCreated++;
    }

    // Parallel steps are independently delegatable. An optional assignee
    // chooses the initial owner; a parallel step without one is still a real
    // unassigned child task. Sequential steps never become child tasks merely
    // because an assignee was accidentally supplied.
    if (step.kind === "parallel" && step.phase === "implementation") {
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
              ...newTaskWorkflowOwnership(),
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

/** Stable acceptance identity; completion is reusable only for this exact requirement. */
export function planStepFingerprint(step: { title: string; acceptanceCriteria: string; kind: string; phase: string; responsibleActor: string; verificationEnvironment: string | null; assigneeId: string | null }) {
  return createHash("sha256").update(JSON.stringify([step.title, step.acceptanceCriteria, step.kind, step.phase, step.responsibleActor, step.verificationEnvironment, step.assigneeId])).digest("hex");
}
