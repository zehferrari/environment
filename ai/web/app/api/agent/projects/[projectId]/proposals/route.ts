// Agent work-item proposal submission (propose → approve).
//
// An agent that received a per-conversation "manage work items" grant on
// a direct chat or Task/Epic Discussion message POSTs a typed change-set
// here. PM validates the grant + token (mirrors /api/tasks/[id]/description),
// dry-run-validates the change-set against lib/workflow.ts, and stores it
// as a PENDING WorkItemProposal. Nothing on the board changes until a
// human applies it (lib/work-items/actions.ts, Slice 3).
//
// Auth model (same shape as the description-write grant):
//   - body.grantMessageId references a DirectAgentChatMessage, or an
//     AgentChatMessage plus the addressed agent's PmChannelRun, with
//     a matching DirectAgentChatMessageProject (or legacy projectId) with
//     allowWorkItemManagement == true and workItemGrantUsedAt == null;
//   - body.token is the HMAC grant token bound to (projectId, agentSlug,
//     messageId);
//   - the slug's Agent + seeded User must be active.
// On success: persist the proposal, stamp the grant used, write an
// ActivityLog row as the agent. Only grants authored by the active Mission
// Control owner are accepted; direct owner grants auto-apply after validation.
// Discussion grants remain pending except narrow workflow
// auto-apply cases such as Epic-manager task breakdowns. Re-using the grant
// returns 410. Re-using the same planId returns the existing proposal
// (idempotent).

import { recordLegacyWorkflowBoundaryInvocation } from "@/lib/tasks/legacy-workflow-boundary";
import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { verifyWorkItemGrantToken } from "@/lib/agents/workflow/token/work-item";
import { validateProposal } from "@/lib/work-items/proposal";
import { commitProposal } from "@/lib/work-items/apply";
import {
  absolutePublicUrl,
  isLoopbackOrigin,
  normalizePublicOrigin,
  publicOriginFromHeaders,
} from "@/lib/http/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WorkItemGrant =
  | {
      source: "direct";
      id: string;
      agentSlug: string;
      projectId: string | null;
      allowWorkItemManagement: boolean;
      workItemGrantUsedAt: Date | null;
      sender: { kind: string; status: string; isOwner: boolean } | null;
      usesProjectLink: boolean;
      taskId?: null;
      epicId?: null;
    }
  | {
      source: "discussion";
      id: string;
      runId: string;
      agentSlug: string;
      projectId: string;
      allowWorkItemManagement: boolean;
      workItemGrantUsedAt: Date | null;
      sender: { kind: string; status: string; isOwner: boolean } | null;
      taskId: string | null;
      epicId: string | null;
    };

class GrantAlreadyUsedError extends Error {
  constructor() {
    super("Grant already used");
    this.name = "GrantAlreadyUsedError";
  }
}

async function findDiscussionGrantRun(projectId: string, grantMessageId: string, token: string) {
  const agents = await db.agent.findMany({
    where: {
      deactivatedAt: null,
      user: { status: "active" },
    },
    select: { slug: true },
  });
  const agentSlug = agents.find((agent) =>
    verifyWorkItemGrantToken(projectId, agent.slug, grantMessageId, token),
  )?.slug ?? null;
  if (!agentSlug) return null;

  const run = await db.pmChannelRun.findFirst({
    where: {
      messageId: grantMessageId,
      agentSlug,
      projectId,
    },
    select: { id: true, agentSlug: true, workItemGrantUsedAt: true },
  });
  return run;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isActiveOwnerGrant(grant: WorkItemGrant): boolean {
  return Boolean(
    grant.sender
      && grant.sender.kind === "human"
      && grant.sender.status === "active"
      && grant.sender.isOwner,
  );
}

async function discussionGrantIsPrivate(grant: Extract<WorkItemGrant, { source: "discussion" }>) {
  if (grant.taskId) {
    const task = await db.task.findUnique({
      where: { id: grant.taskId },
      select: {
        private: true,
        epic: { select: { private: true } },
        parent: { select: { private: true, epic: { select: { private: true } } } },
      },
    });
    return Boolean(task?.private || task?.epic?.private || task?.parent?.private || task?.parent?.epic?.private);
  }
  if (grant.epicId) {
    const epic = await db.epic.findUnique({
      where: { id: grant.epicId },
      select: { private: true },
    });
    return Boolean(epic?.private);
  }
  return false;
}

function isEpicManagerTaskBreakdown(operations: unknown[], epicId: string) {
  const topLevelTaskRefs = new Set<string>();
  const subtaskRefs = new Set<string>();

  for (const raw of operations) {
    if (!isRecord(raw)) return false;
    if (raw.op === "create_task") {
      if (raw.epic !== epicId) return false;
      if (typeof raw.ref !== "string" || !raw.ref.startsWith("tmp:")) return false;
      topLevelTaskRefs.add(raw.ref);
      continue;
    }
    if (raw.op === "create_subtask") {
      if (typeof raw.ref !== "string" || !raw.ref.startsWith("tmp:")) return false;
      if (typeof raw.parent !== "string" || !topLevelTaskRefs.has(raw.parent)) return false;
      subtaskRefs.add(raw.ref);
      continue;
    }
    return false;
  }

  return topLevelTaskRefs.size > 0 && subtaskRefs.size + topLevelTaskRefs.size === operations.length;
}

async function canAutoApplyEpicManagerTaskBreakdown(args: {
  grant: WorkItemGrant;
  projectId: string;
  agentUserId: string;
  operations: unknown[];
}) {
  if (args.grant.source !== "discussion" || !args.grant.epicId) return false;
  if (!isEpicManagerTaskBreakdown(args.operations, args.grant.epicId)) return false;

  const epic = await db.epic.findFirst({
    where: {
      id: args.grant.epicId,
      projectId: args.projectId,
      actingManagerId: args.agentUserId,
      deletedAt: null,
    },
    select: { id: true },
  });
  return Boolean(epic);
}

function parsePayloadOrigin(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { publicOrigin?: unknown };
    return normalizePublicOrigin(parsed.publicOrigin);
  } catch {
    return null;
  }
}

async function storedPublicOriginForGrant(grant: WorkItemGrant): Promise<string | null> {
  const kinds = grant.source === "direct"
    ? ["agent.direct_chat.send"]
    : grant.taskId
      ? ["task.chat.send"]
      : ["epic.chat.send"];
  const row = await db.activityLog.findFirst({
    where: {
      kind: { in: kinds },
      ...(grant.source === "direct" ? { targetAgent: grant.agentSlug } : {}),
      payload: { contains: `"messageId":"${grant.id}"` },
    },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  return parsePayloadOrigin(row?.payload ?? null);
}

function publicOriginFallback(req: NextRequest): string | null {
  const appUrl = normalizePublicOrigin(process.env.APP_URL);
  if (appUrl) return appUrl;
  const fromHeaders = publicOriginFromHeaders(req.headers);
  return isLoopbackOrigin(fromHeaders) ? null : fromHeaders;
}

function publicCreatedItems<T extends { url: string }>(items: T[] | undefined, origin: string | null) {
  return (items ?? []).map((item) => ({
    ...item,
    url: absolutePublicUrl(item.url, origin),
  }));
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "proposal-application",
    entryPoint: "POST",
  });
  const { projectId } = await ctx.params;

  let payload: {
    grantMessageId?: unknown;
    token?: unknown;
    publicOrigin?: unknown;
    planId?: unknown;
    summary?: unknown;
    operations?: unknown;
  };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const grantMessageId =
    typeof payload.grantMessageId === "string" ? payload.grantMessageId : "";
  const token = typeof payload.token === "string" ? payload.token : "";
  const requestedPublicOrigin = normalizePublicOrigin(payload.publicOrigin);
  const planId = typeof payload.planId === "string" ? payload.planId : "";
  const summary =
    typeof payload.summary === "string" && payload.summary.trim()
      ? payload.summary.trim().slice(0, 280)
      : null;
  const operations = payload.operations;

  if (!grantMessageId || !token || !planId) {
    return NextResponse.json(
      { error: "grantMessageId, token, and planId are required" },
      { status: 400 },
    );
  }
  if (!Array.isArray(operations)) {
    return NextResponse.json(
      { error: "operations must be a JSON array" },
      { status: 400 },
    );
  }

  const directGrant = await db.directAgentChatMessage.findUnique({
    where: { id: grantMessageId },
    select: {
      id: true,
      agentSlug: true,
      projectId: true,
      allowWorkItemManagement: true,
      workItemGrantUsedAt: true,
      sender: { select: { kind: true, status: true, isOwner: true } },
      projects: {
        where: { projectId },
        select: {
          projectId: true,
          allowWorkItemManagement: true,
          workItemGrantUsedAt: true,
        },
      },
    },
  });
  const directProjectGrant = directGrant?.projects[0] ?? null;
  let grant: WorkItemGrant | null = directGrant
    ? {
        source: "direct",
        id: directGrant.id,
        agentSlug: directGrant.agentSlug,
        projectId: directProjectGrant?.projectId ?? directGrant.projectId,
        allowWorkItemManagement:
          directProjectGrant?.allowWorkItemManagement ?? directGrant.allowWorkItemManagement,
        workItemGrantUsedAt:
          directProjectGrant?.workItemGrantUsedAt ?? directGrant.workItemGrantUsedAt,
        sender: directGrant.sender,
        usesProjectLink: Boolean(directProjectGrant),
      }
    : null;

  if (!grant) {
    const discussionGrant = await db.agentChatMessage.findUnique({
      where: { id: grantMessageId },
      select: {
        id: true,
        projectId: true,
        taskId: true,
        epicId: true,
        allowWorkItemManagement: true,
        workItemGrantUsedAt: true,
        sender: { select: { kind: true, status: true, isOwner: true } },
      },
    });
    if (discussionGrant) {
      const run = await findDiscussionGrantRun(projectId, grantMessageId, token);
      if (!run) {
        return NextResponse.json({ error: "Invalid grant token" }, { status: 403 });
      }
      grant = {
        ...discussionGrant,
        source: "discussion",
        runId: run.id,
        agentSlug: run.agentSlug,
        workItemGrantUsedAt: run.workItemGrantUsedAt,
      };
    }
  }

  if (!grant) {
    return NextResponse.json({ error: "Grant message not found" }, { status: 404 });
  }
  if (grant.projectId !== projectId) {
    return NextResponse.json(
      { error: "Grant message is not bound to this project" },
      { status: 400 },
    );
  }
  if (!grant.allowWorkItemManagement) {
    return NextResponse.json(
      { error: "Message did not grant work-item management" },
      { status: 403 },
    );
  }
  if (
    grant.source === "direct"
    && !verifyWorkItemGrantToken(projectId, grant.agentSlug, grantMessageId, token)
  ) {
    return NextResponse.json({ error: "Invalid grant token" }, { status: 403 });
  }
  if (!isActiveOwnerGrant(grant)) {
    return NextResponse.json(
      { error: "Work-item execution requires an active Mission Control owner requester" },
      { status: 403 },
    );
  }
  if (grant.source === "discussion" && await discussionGrantIsPrivate(grant)) {
    return NextResponse.json(
      { error: "Discussion work-item execution is unavailable for private work" },
      { status: 403 },
    );
  }

  // Authenticate the grant before returning an idempotent proposal. Otherwise
  // a legacy non-owner grant could keep receiving a successful retry response
  // merely by reusing a stored planId.
  const existing = await db.workItemProposal.findUnique({
    where: { planId },
    select: { id: true, projectId: true, status: true },
  });
  if (existing) {
    if (existing.projectId !== projectId) {
      return NextResponse.json(
        { error: "planId already used in another project" },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      proposalId: existing.id,
      status: existing.status,
      idempotent: true,
    });
  }
  if (grant.workItemGrantUsedAt) {
    return NextResponse.json({ error: "Grant already used" }, { status: 410 });
  }

  const agent = await db.agent.findUnique({
    where: { slug: grant.agentSlug },
    select: {
      slug: true,
      deactivatedAt: true,
      user: { select: { id: true, status: true } },
    },
  });
  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return NextResponse.json({ error: "Agent not active" }, { status: 403 });
  }
  const agentUserId = agent.user.id;

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, slug: true, deletedAt: true },
  });
  if (!project || project.deletedAt) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const validation = await validateProposal(projectId, operations, {
    userId: agentUserId,
    agentSlug: grant.agentSlug,
  });
  if (!validation.ok) {
    // Validation failure does NOT consume the grant, so the agent can
    // correct the change-set and resubmit with the same grant.
    return NextResponse.json(
      { ok: false, error: "Proposal failed validation", validation },
      { status: 422 },
    );
  }

  const autoApplyDirectOwnerRequest = grant.source === "direct" && isActiveOwnerGrant(grant);
  const autoApplyEpicManagerBreakdown = await canAutoApplyEpicManagerTaskBreakdown({
    grant,
    projectId,
    agentUserId,
    operations,
  });
  const autoApply = autoApplyDirectOwnerRequest || autoApplyEpicManagerBreakdown;
  const publicOrigin =
    await storedPublicOriginForGrant(grant) ??
    requestedPublicOrigin ??
    publicOriginFallback(req);

  try {
    const created = await db.$transaction(async (tx) => {
      // Claim the advertised one-shot grant in the same transaction as the
      // proposal. The earlier read gives a fast 410 for normal retries; this
      // compare-and-set closes the race between distinct concurrent planIds.
      let consumed = 0;
      if (grant.source === "direct") {
        if (grant.usesProjectLink) {
          consumed = (await tx.directAgentChatMessageProject.updateMany({
            where: {
              messageId: grantMessageId,
              projectId,
              allowWorkItemManagement: true,
              workItemGrantUsedAt: null,
            },
            data: { workItemGrantUsedAt: new Date() },
          })).count;
        } else {
          consumed = (await tx.directAgentChatMessage.updateMany({
            where: {
              id: grantMessageId,
              projectId,
              allowWorkItemManagement: true,
              workItemGrantUsedAt: null,
            },
            data: { workItemGrantUsedAt: new Date() },
          })).count;
        }
      } else {
        consumed = (await tx.pmChannelRun.updateMany({
          where: { id: grant.runId, workItemGrantUsedAt: null },
          data: { workItemGrantUsedAt: new Date() },
        })).count;
      }
      if (consumed !== 1) throw new GrantAlreadyUsedError();

      const proposal = await tx.workItemProposal.create({
        data: {
          planId,
          projectId,
          agentSlug: grant.agentSlug,
          grantMessageId,
          proposedByUserId: agentUserId,
          status: "pending",
          summary,
          operations: JSON.stringify(operations),
          validation: JSON.stringify(validation),
        },
        select: { id: true },
      });
      await tx.activityLog.create({
        data: {
          projectId,
          userId: agentUserId,
          kind: "workitem.proposal.propose",
          targetAgent: grant.agentSlug,
          payload: JSON.stringify({
            proposalId: proposal.id,
            planId,
            opCount: validation.opCount,
            summary,
          }),
        },
      });
      return proposal;
    });

    if (autoApply) {
      const applied = await commitProposal(created.id, agentUserId);
      if (!applied.ok) {
        return NextResponse.json(
          {
            ok: false,
            proposalId: created.id,
            status: "pending",
            error: applied.error,
          },
          { status: 409 },
        );
      }
      revalidatePath(`/projects/${project.slug}`);
      if (grant.epicId) {
        revalidatePath(`/projects/${project.slug}/epics/${grant.epicId}`);
      }
      return NextResponse.json(
        {
          ok: true,
          proposalId: created.id,
          status: "applied",
          autoApplied: true,
          autoApplyReason: autoApplyDirectOwnerRequest
            ? "direct_owner_request"
            : "epic_manager_task_breakdown",
          validation,
          result: applied.counts,
          links: publicCreatedItems(applied.createdItems, publicOrigin),
        },
        { status: 201 },
      );
    }

    if (grant.source === "direct") {
      revalidatePath(`/agents/${grant.agentSlug}/chat`);
    } else if (grant.taskId) {
      revalidatePath(`/projects/${project.slug}/tasks/${grant.taskId}`);
    } else if (grant.epicId) {
      revalidatePath(`/projects/${project.slug}/epics/${grant.epicId}`);
    }
    return NextResponse.json(
      { ok: true, proposalId: created.id, status: "pending", validation },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof GrantAlreadyUsedError) {
      // A same-plan concurrent retry may have lost the grant CAS only because
      // its identical proposal committed first. Preserve idempotent semantics
      // while rejecting a genuinely distinct replay.
      const winner = await db.workItemProposal.findUnique({
        where: { planId },
        select: { id: true, projectId: true, status: true },
      });
      if (winner?.projectId === projectId) {
        return NextResponse.json({
          ok: true,
          proposalId: winner.id,
          status: winner.status,
          idempotent: true,
        });
      }
      return NextResponse.json({ error: "Grant already used" }, { status: 410 });
    }
    // Lost the idempotency race: another request with the same planId won
    // the unique index between our findUnique and create. Return theirs.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await db.workItemProposal.findUnique({
        where: { planId },
        select: { id: true, projectId: true, status: true },
      });
      if (winner) {
        if (winner.projectId !== projectId) {
          return NextResponse.json(
            { error: "planId already used in another project" },
            { status: 409 },
          );
        }
        return NextResponse.json({
          ok: true,
          proposalId: winner.id,
          status: winner.status,
          idempotent: true,
        });
      }
    }
    throw err;
  }
}
