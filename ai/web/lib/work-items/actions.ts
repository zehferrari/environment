"use server";

// Human apply/reject server actions for agent work-item proposals
// (Slice 3). Auth + cache revalidation only; the transactional commit
// lives in lib/work-items/apply.ts (auth-free, unit-testable).

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commitProposal } from "@/lib/work-items/apply";

async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  return id;
}

export async function applyWorkItemProposal(formData: FormData) {
  const userId = await requireUserId();
  const proposalId = String(formData.get("proposalId") ?? "").trim();
  const fallbackAgentSlug = String(formData.get("agentSlug") ?? "").trim();
  if (!proposalId) return;

  const result = await commitProposal(proposalId, userId);

  const agentSlug = result.agentSlug || fallbackAgentSlug;
  if (agentSlug) revalidatePath(`/agents/${agentSlug}/chat`);
  if (result.ok && result.projectSlug) {
    revalidatePath(`/projects/${result.projectSlug}`);
    revalidatePath(`/projects/${result.projectSlug}/epics`);
    if (result.taskId) {
      revalidatePath(`/projects/${result.projectSlug}/tasks/${result.taskId}`);
    }
    if (result.epicId) {
      revalidatePath(`/projects/${result.projectSlug}/epics/${result.epicId}`);
    }
  }

  // Re-validation failure is the only case worth surfacing loudly (state
  // drifted since the agent proposed). Already-applied / not-found just
  // no-op so a double-click doesn't blow up.
  if (!result.ok && result.error?.startsWith("Re-validation")) {
    throw new Error(result.error);
  }
}

export async function rejectWorkItemProposal(formData: FormData) {
  const userId = await requireUserId();
  const proposalId = String(formData.get("proposalId") ?? "").trim();
  if (!proposalId) return;

  const proposal = await db.workItemProposal.findUnique({
    where: { id: proposalId },
    select: { id: true, status: true, agentSlug: true, projectId: true, grantMessageId: true },
  });
  if (!proposal || proposal.status !== "pending") return;

  let taskId: string | null = null;
  let epicId: string | null = null;
  if (proposal.grantMessageId) {
    const msg = await db.agentChatMessage.findUnique({
      where: { id: proposal.grantMessageId },
      select: { taskId: true, epicId: true },
    });
    if (msg) {
      taskId = msg.taskId;
      epicId = msg.epicId;
    }
  }

  await db.$transaction([
    db.workItemProposal.update({
      where: { id: proposalId },
      data: { status: "rejected", rejectedById: userId, rejectedAt: new Date() },
    }),
    db.activityLog.create({
      data: {
        projectId: proposal.projectId,
        userId,
        kind: "workitem.proposal.reject",
        targetAgent: proposal.agentSlug,
        payload: JSON.stringify({ proposalId, agentSlug: proposal.agentSlug }),
      },
    }),
  ]);

  revalidatePath(`/agents/${proposal.agentSlug}/chat`);
  const project = await db.project.findUnique({
    where: { id: proposal.projectId },
    select: { slug: true },
  });
  if (project) {
    revalidatePath(`/projects/${project.slug}`);
    revalidatePath(`/projects/${project.slug}/epics`);
    if (taskId) {
      revalidatePath(`/projects/${project.slug}/tasks/${taskId}`);
    }
    if (epicId) {
      revalidatePath(`/projects/${project.slug}/epics/${epicId}`);
    }
  }
}
