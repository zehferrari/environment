import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type Client = Prisma.TransactionClient | typeof db;

/** Definitions, rather than checkbox state, bind a reviewer verdict. Recording
 * owner evidence must not invalidate the verdict; changing a criterion must. */
export async function acceptanceChecklistSnapshot(client: Client, taskId: string) {
  const task = await client.task.findUniqueOrThrow({ where: { id: taskId }, select: {
    actionPlan: { select: { version: true, contentHash: true } },
    checklist: { where: { kind: { not: "superseded" } }, orderBy: { id: "asc" }, select: {
      id: true, text: true, kind: true, responsibleActor: true, verificationEnvironment: true,
      acceptanceGate: true, planStepKey: true, planContentHash: true,
    } },
  } });
  return {
    planVersion: task.actionPlan?.version ?? 0,
    checklistHash: createHash("sha256").update(JSON.stringify({ plan: task.actionPlan, checks: task.checklist })).digest("hex"),
  };
}

export async function openEpicReleaseChecks(client: Client, epicId: string) {
  return client.subTask.findMany({ where: {
    acceptanceGate: "epic_release", kind: { not: "superseded" }, completedAt: null,
    task: { epicId, deletedAt: null },
  }, select: { id: true, text: true, taskId: true, responsibleActor: true,
    task: { select: { title: true, workItemKey: true } } }, orderBy: { createdAt: "asc" } });
}

export async function assertEpicReleaseChecksComplete(client: Client, epicId: string) {
  const pending = await openEpicReleaseChecks(client, epicId);
  if (pending.length) throw new Error(`[owner_acceptance_pending] Epic release requires ${pending.length} acceptance check(s): ${pending.map(c => `${c.task.workItemKey ?? c.task.title}: ${c.text}`).join("; ")}. Record the responsible owner's evidence on each Task.`);
}
