import "./lib/next-als-polyfill";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import { createWorkItemGrantToken } from "../lib/agents/workflow/token/work-item";
import { runRouteHandler } from "./lib/next-route-harness";

const execFileP = promisify(execFile);

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

type ProposalResponse = {
  ok?: boolean;
  error?: string;
  proposalId?: string;
  status?: string;
  autoApplied?: boolean;
  autoApplyReason?: string;
  idempotent?: boolean;
  reviewUrl?: string;
};

async function main() {
  process.env.AUTH_SECRET = "work-item-proposal-authorization-test-secret";
  const tmp = await mkdtemp(path.join(tmpdir(), "work-item-proposal-auth-"));
  const originalDbUrl = process.env.DATABASE_URL;
  let db: PrismaClient | undefined;

  try {
    const dbUrl = `file:${path.join(tmp, "test.db")}`;
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;

    const [{ db: prisma }, route, proposal, { NextRequest }] = await Promise.all([
      import("../lib/db"),
      import("../app/api/agent/projects/[projectId]/proposals/route"),
      import("../lib/work-items/proposal"),
      import("next/server"),
    ]);
    const testDb = prisma as PrismaClient;
    db = testDb;

    const owner = await db.user.create({
      data: {
        username: "proposal-owner",
        email: "proposal-owner@example.test",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const member = await db.user.create({
      data: {
        username: "proposal-member",
        email: "proposal-member@example.test",
        kind: "human",
        mustRotatePassword: false,
      },
    });
    const disabledOwner = await db.user.create({
      data: {
        username: "proposal-disabled-owner",
        email: "proposal-disabled-owner@example.test",
        kind: "human",
        isOwner: true,
        status: "deactivated",
        mustRotatePassword: false,
      },
    });
    const agent = await db.agent.create({
      data: { slug: "proposal-agent", name: "Proposal Agent", role: "coding" },
    });
    const agentUser = await db.user.create({
      data: {
        username: "proposal-agent",
        email: "proposal-agent@example.test",
        kind: "agent",
        agentId: agent.id,
        mustRotatePassword: false,
      },
    });
    const secondAgent = await db.agent.create({
      data: { slug: "proposal-agent-two", name: "Proposal Agent Two", role: "coding" },
    });
    await db.user.create({
      data: {
        username: "proposal-agent-two",
        email: "proposal-agent-two@example.test",
        kind: "agent",
        agentId: secondAgent.id,
        mustRotatePassword: false,
      },
    });
    const project = await db.project.create({
      data: { slug: "proposal-auth", name: "Proposal Authorization" },
    });
    const publicTask = await db.task.create({
      data: { projectId: project.id, title: "Public task" },
    });
    const privateEpic = await db.epic.create({
      data: { projectId: project.id, title: "Private epic", private: true },
    });
    const privateTask = await db.task.create({
      data: { projectId: project.id, title: "Private task", private: true },
    });
    const publicTaskWithPrivateBlocker = await db.task.create({
      data: {
        projectId: project.id,
        title: "Public task with private blocker",
        blockedById: privateTask.id,
      },
    });
    const publicTaskInPrivateEpic = await db.task.create({
      data: { projectId: project.id, epicId: privateEpic.id, title: "Public task under private epic" },
    });
    const privateParent = await db.task.create({
      data: { projectId: project.id, title: "Private parent", private: true },
    });
    const publicChildOfPrivateParent = await db.task.create({
      data: {
        projectId: project.id,
        parentTaskId: privateParent.id,
        title: "Public child under private parent",
      },
    });

    const createOp = (title: string) => [
      { op: "create_epic", ref: "tmp:epic", title },
    ];
    const callProposal = async (args: {
      messageId: string;
      planId: string;
      title: string;
      operations?: unknown[];
    }) => {
      const token = createWorkItemGrantToken(project.id, agent.slug, args.messageId);
      const req = new NextRequest(`http://127.0.0.1/api/agent/projects/${project.id}/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grantMessageId: args.messageId,
          token,
          planId: args.planId,
          operations: args.operations ?? createOp(args.title),
        }),
      });
      const response = await runRouteHandler(() => route.POST(req, {
        params: Promise.resolve({ projectId: project.id }),
      }));
      return { status: response.status, body: await response.json() as ProposalResponse };
    };
    const directGrant = async (id: string, senderUserId: string) => testDb.directAgentChatMessage.create({
      data: {
        id,
        agentSlug: agent.slug,
        senderUserId,
        projectId: project.id,
        body: "Please manage this project",
        allowWorkItemManagement: true,
      },
    });
    const discussionGrant = async (id: string, senderUserId: string, taskId: string | null) => {
      const message = await testDb.agentChatMessage.create({
        data: {
          id,
          projectId: project.id,
          taskId,
          agentSlug: agent.slug,
          targetType: "agent",
          targetValue: `agent:${agent.slug}`,
          targetLabel: `@${agent.slug}`,
          senderUserId,
          body: "Please manage this task",
          allowWorkItemManagement: true,
        },
      });
      await testDb.pmChannelRun.create({
        data: {
          targetKey: `proposal-auth:${id}`,
          kind: "task-chat",
          agentSlug: agent.slug,
          messageId: message.id,
          projectId: project.id,
          taskId,
        },
      });
      return message;
    };

    // A legacy direct grant from a normal member is rejected even though its
    // old allowWorkItemManagement bit is true, and is left unconsumed.
    const memberDirect = await directGrant("direct-member", member.id);
    const memberDirectResult = await callProposal({
      messageId: memberDirect.id,
      planId: "proposal-direct-member",
      title: "Member should not create this",
    });
    assert.equal(memberDirectResult.status, 403, "non-owner direct grant is rejected");
    assert.match(memberDirectResult.body.error ?? "", /Mission Control owner/, "direct rejection identifies owner requirement");
    assert.equal(
      (await db.directAgentChatMessage.findUniqueOrThrow({ where: { id: memberDirect.id } })).workItemGrantUsedAt,
      null,
      "rejected non-owner direct grant remains unconsumed",
    );
    await db.workItemProposal.create({
      data: {
        planId: "proposal-direct-member-existing",
        projectId: project.id,
        agentSlug: agent.slug,
        proposedByUserId: agentUser.id,
        operations: "[]",
      },
    });
    const memberExistingPlanResult = await callProposal({
      messageId: memberDirect.id,
      planId: "proposal-direct-member-existing",
      title: "Legacy plan must not bypass owner authorization",
    });
    assert.equal(memberExistingPlanResult.status, 403, "legacy non-owner plans do not bypass grant authorization through idempotency");

    const disabledOwnerDirect = await directGrant("direct-disabled-owner", disabledOwner.id);
    const disabledOwnerResult = await callProposal({
      messageId: disabledOwnerDirect.id,
      planId: "proposal-direct-disabled-owner",
      title: "Disabled owner should not create this",
    });
    assert.equal(disabledOwnerResult.status, 403, "deactivated owner direct grant is rejected");

    const ownerDirect = await directGrant("direct-owner", owner.id);
    const ownerDirectResult = await callProposal({
      messageId: ownerDirect.id,
      planId: "proposal-direct-owner",
      title: "Owner direct auto apply",
    });
    assert.equal(ownerDirectResult.status, 201, "owner direct grant is accepted");
    assert.equal(ownerDirectResult.body.status, "applied", "owner direct grant auto-applies");
    assert.equal(ownerDirectResult.body.autoApplied, true, "owner direct grant reports auto-apply");
    assert.equal(ownerDirectResult.body.autoApplyReason, "direct_owner_request", "auto-apply is attributed to the owner grant");
    assert.equal(
      (await db.workItemProposal.findUniqueOrThrow({ where: { planId: "proposal-direct-owner" } })).appliedById,
      owner.id,
      "direct owner auto-apply records the owner as approver",
    );
    const ownerDirectRetry = await callProposal({
      messageId: ownerDirect.id,
      planId: "proposal-direct-owner",
      title: "Owner direct auto apply",
    });
    assert.equal(ownerDirectRetry.status, 200, "owner retries remain idempotent after the grant is consumed");
    assert.equal(ownerDirectRetry.body.idempotent, true, "owner retry returns its stored proposal");

    const memberDiscussion = await discussionGrant("discussion-member", member.id, publicTask.id);
    const memberDiscussionResult = await callProposal({
      messageId: memberDiscussion.id,
      planId: "proposal-discussion-member",
      title: "Member discussion should not create this",
    });
    assert.equal(memberDiscussionResult.status, 403, "non-owner discussion grant is rejected");
    assert.equal(
      (await db.pmChannelRun.findFirstOrThrow({ where: { messageId: memberDiscussion.id } })).workItemGrantUsedAt,
      null,
      "rejected non-owner discussion grant remains unconsumed",
    );

    const ownerDiscussion = await discussionGrant("discussion-owner", owner.id, publicTask.id);
    const ownerDiscussionResult = await callProposal({
      messageId: ownerDiscussion.id,
      planId: "proposal-discussion-owner",
      title: "Owner discussion proposal",
    });
    assert.equal(ownerDiscussionResult.status, 201, "owner discussion grant is accepted");
    assert.equal(ownerDiscussionResult.body.status, "pending", "owner discussion grant stays pending for review");
    assert.equal(ownerDiscussionResult.body.autoApplied, undefined, "only direct owner grants auto-apply");
    const reviewLink = new URL(ownerDiscussionResult.body.reviewUrl!, "https://pm.test");
    assert.equal(reviewLink.pathname, "/proposals", "pending task proposals link to the owner inbox, not direct agent chat");
    assert.equal(reviewLink.hash, `#proposal-${ownerDiscussionResult.body.proposalId}`);
    const discussionRetry = await callProposal({ messageId: ownerDiscussion.id, planId: "proposal-discussion-owner", title: "Owner discussion proposal" });
    assert.equal(discussionRetry.body.idempotent, true);
    assert.equal(discussionRetry.body.reviewUrl, ownerDiscussionResult.body.reviewUrl, "a retry retains the exact review destination");
    const React = await import("react");
    (globalThis as typeof globalThis & { React: typeof React }).React = React;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: ProposalReview } = await import("../app/(app)/agents/[agent]/chat/proposal-review");
    const { withProposalReviewContext } = await import("../lib/work-items/proposal-review-context");
    const relatedEpic = await db.epic.create({ data: { projectId: project.id, title: "Related epic", status: "In Progress" } });
    const relatedTask = await db.task.create({ data: { projectId: project.id, epicId: relatedEpic.id, title: "Related task", workItemKey: "TEST-42", status: "Review" } });
    const otherProject = await db.project.create({ data: { slug: "other-proposal-project", name: "Other project" } });
    const unrelatedTask = await db.task.create({ data: { projectId: otherProject.id, title: "Must not leak" } });
    const contextInput = [{ projectId: project.id, grantMessageId: ownerDiscussion.id, operations: JSON.stringify([
      { op: "update_task", target: relatedTask.id, status: "To Do", epic: "tmp:new-epic" },
      { op: "comment_task", target: relatedTask.id, body: "Duplicate reference" },
      { op: "comment_task", target: unrelatedTask.id, body: "Wrong project" },
      { op: "comment_task", target: "missing-task", body: "Missing" },
      { op: "create_subtask", parent: "tmp:new-task", title: "Proposed child" },
    ]) }];
    let [context] = await withProposalReviewContext(contextInput);
    assert.equal(context.relatedItems.filter(item => item.id === relatedTask.id).length, 1, "deduplicate operation targets");
    assert.equal(context.relatedItems.find(item => item.id === relatedTask.id)?.status, "Review", "show live status, not the proposed status");
    assert.equal(context.relatedItems.find(item => item.id === relatedEpic.id)?.status, "In Progress", "include the task's current Epic");
    assert.ok(context.relatedItems.some(item => item.id === publicTask.id), "include the source conversation task");
    assert.equal(context.relatedItems.find(item => item.id === unrelatedTask.id)?.status, "Unavailable", "project boundaries remain enforced");
    assert.equal(context.relatedItems.find(item => item.id === unrelatedTask.id)?.href, undefined);
    assert.equal(context.relatedItems.find(item => item.id === "missing-task")?.status, "Unavailable");
    assert.ok(!JSON.stringify(context.relatedItems).includes("Must not leak"));
    assert.ok(!context.relatedItems.some(item => item.id.startsWith("tmp:")), "new proposed items do not have a current status");
    await db.task.update({ where: { id: relatedTask.id }, data: { status: "Done", archivedAt: new Date() } });
    [context] = await withProposalReviewContext(contextInput);
    assert.equal(context.relatedItems.find(item => item.id === relatedTask.id)?.status, "Done", "refresh resolves status changes on an old proposal");
    assert.equal(context.relatedItems.find(item => item.id === relatedTask.id)?.archived, true);
    const publishedAt = "2026-09-01T03:04:00.000Z";
    const reviewMarkup = renderToStaticMarkup(React.createElement(ProposalReview, { proposals: [{
      id: ownerDiscussionResult.body.proposalId!, summary: "Review this update", operations: "[]", validation: null,
      createdAt: publishedAt, projectName: "Test project", agentSlug: agent.slug,
      relatedItems: context.relatedItems,
      sourceUrl: `/projects/${project.slug}/tasks/${publicTask.id}`,
    }] }));
    assert.ok(reviewMarkup.includes(`id="proposal-${ownerDiscussionResult.body.proposalId}"`), "the returned link resolves to a rendered review card");
    assert.ok(reviewMarkup.includes(`dateTime="${publishedAt}"`), "publication date retains the exact timestamp");
    assert.ok(reviewMarkup.includes("1 Sept 2026") && reviewMarkup.includes("1:04 pm") && reviewMarkup.includes("AEST"), "publication date uses an explicit, stable timezone");
    assert.ok(reviewMarkup.includes("Related work · current status") && reviewMarkup.includes("Done") && reviewMarkup.includes("Archived"));
    assert.ok(reviewMarkup.includes(`/projects/${project.slug}/tasks/${relatedTask.id}`));
    await db.task.update({ where: { id: relatedTask.id }, data: { deletedAt: new Date() } });
    const [deletedContext] = await withProposalReviewContext(contextInput);
    const deletedItem = deletedContext.relatedItems.find(item => item.id === relatedTask.id);
    assert.equal(deletedItem?.status, "Deleted");
    assert.equal(deletedItem?.href, undefined, "deleted items have no broken detail link");
    assert.equal(deletedItem?.label, "TEST-42", "deleted item titles are not exposed");
    assert.deepEqual((await withProposalReviewContext([{ projectId: project.id, grantMessageId: null, operations: "malformed" }]))[0].relatedItems, []);
    assert.ok(reviewMarkup.includes('name="proposalId"'), "review card carries an actionable proposal identity");
    assert.ok(reviewMarkup.includes("Original conversation"));

    const ownerTaskDiscussion = await discussionGrant("discussion-owner-task", owner.id, publicTask.id);
    const ownerTaskDiscussionResult = await callProposal({
      messageId: ownerTaskDiscussion.id,
      planId: "proposal-discussion-owner-task",
      title: "Owner discussion task",
      operations: [{ op: "create_task", ref: "tmp:task", title: "Owner discussion task" }],
    });
    assert.equal(ownerTaskDiscussionResult.status, 201, "owner task request in a discussion is accepted");
    assert.equal(ownerTaskDiscussionResult.body.status, "applied", "owner task request is applied immediately");
    assert.equal(ownerTaskDiscussionResult.body.autoApplied, true, "owner task request reports auto-apply");
    assert.equal(ownerTaskDiscussionResult.body.autoApplyReason, "owner_task_request", "task auto-apply reason is explicit");
    const createdOwnerTask = await db.task.findFirstOrThrow({
      where: { projectId: project.id, title: "Owner discussion task" },
    });
    assert.equal(createdOwnerTask.status, "Backlog", "immediately created owner task starts in Backlog");
    assert.equal(createdOwnerTask.reporterId, owner.id, "the requesting owner is the created task reporter");
    assert.equal(
      (await db.workItemProposal.findUniqueOrThrow({ where: { planId: "proposal-discussion-owner-task" } })).appliedById,
      owner.id,
      "discussion task auto-apply records the owner as approver",
    );

    const multiAgentDiscussion = await discussionGrant("discussion-owner-multi-agent", owner.id, publicTask.id);
    await db.agentChatMessage.update({
      where: { id: multiAgentDiscussion.id },
      data: { targetType: "all-coders", targetValue: "all-coders", targetLabel: "All Coders" },
    });
    await db.pmChannelRun.create({
      data: {
        targetKey: "proposal-auth:discussion-owner-multi-agent:second",
        kind: "task-chat",
        agentSlug: secondAgent.slug,
        messageId: multiAgentDiscussion.id,
        projectId: project.id,
        taskId: publicTask.id,
      },
    });
    const multiAgentTaskResult = await callProposal({
      messageId: multiAgentDiscussion.id,
      planId: "proposal-discussion-owner-multi-agent-task",
      title: "Multi-agent task must await review",
      operations: [{ op: "create_task", ref: "tmp:task", title: "Multi-agent task must await review" }],
    });
    assert.equal(multiAgentTaskResult.body.status, "pending", "multi-agent task creation does not auto-apply");
    assert.equal(
      await db.task.count({ where: { projectId: project.id, title: "Multi-agent task must await review" } }),
      0,
      "multi-agent task creation cannot race into duplicate board tasks",
    );

    const pendingFromAgentSpecificComment = await (await import("../lib/tasks/cache"))
      .findPendingTaskProposals(publicTask.id, project.id);
    assert.ok(
      pendingFromAgentSpecificComment.some((candidate) => candidate.id === ownerDiscussionResult.body.proposalId),
      "task proposal lookup includes agent-specific messages mirrored from Comments",
    );

    const privateDiscussion = await discussionGrant("discussion-private", owner.id, publicTaskInPrivateEpic.id);
    const privateDiscussionResult = await callProposal({
      messageId: privateDiscussion.id,
      planId: "proposal-discussion-private",
      title: "Private discussion must not create this",
    });
    assert.equal(privateDiscussionResult.status, 403, "discussion grants bound to private work are rejected");
    assert.equal(
      (await db.pmChannelRun.findFirstOrThrow({ where: { messageId: privateDiscussion.id } })).workItemGrantUsedAt,
      null,
      "private discussion grant remains unconsumed",
    );

    const proposalActor = { userId: agentUser.id, agentSlug: agent.slug };
    const privateEpicReference = await proposal.validateProposal(project.id, [
      { op: "create_task", ref: "tmp:task", title: "No private epic link", epic: privateEpic.id },
    ], proposalActor);
    assert.equal(privateEpicReference.ok, false, "private Epic ids cannot resolve in proposal validation");

    const privateTaskReference = await proposal.validateProposal(project.id, [
      { op: "update_task", target: privateTask.id, title: "No private task update" },
    ], proposalActor);
    assert.equal(privateTaskReference.ok, false, "private Task ids cannot resolve in proposal validation");

    const privateCreateBlockerReference = await proposal.validateProposal(project.id, [
      { op: "create_task", ref: "tmp:dependent", title: "No private blocker", blockedBy: privateTask.id },
    ], proposalActor);
    assert.equal(privateCreateBlockerReference.ok, false, "private Task ids cannot be create_task blockers");

    const privateUpdateBlockerReference = await proposal.validateProposal(project.id, [
      { op: "update_task", target: publicTask.id, blockedBy: privateTask.id },
    ], proposalActor);
    assert.equal(privateUpdateBlockerReference.ok, false, "private Task ids cannot be update_task blockers");

    const hiddenCurrentBlockerClear = await proposal.validateProposal(project.id, [
      { op: "update_task", target: publicTaskWithPrivateBlocker.id, blockedBy: null },
    ], proposalActor);
    assert.equal(hiddenCurrentBlockerClear.ok, false, "agents cannot clear an inaccessible current blocker");
    assert.equal(
      hiddenCurrentBlockerClear.results.some((result) => result.errors.some((error) => error.includes(privateTask.id))),
      false,
      "hidden-current-blocker validation does not disclose the private blocker id",
    );

    const privateEpicTaskReference = await proposal.validateProposal(project.id, [
      { op: "comment_task", target: publicTaskInPrivateEpic.id, body: "No private-epic comment" },
    ], proposalActor);
    assert.equal(privateEpicTaskReference.ok, false, "tasks under private Epics cannot resolve in proposal validation");

    const privateParentTaskReference = await proposal.validateProposal(project.id, [
      { op: "create_subtask", ref: "tmp:subtask", parent: publicChildOfPrivateParent.id, title: "No private-parent child" },
    ], proposalActor);
    assert.equal(privateParentTaskReference.ok, false, "tasks under private parents cannot resolve in proposal validation");

    console.log("work-item-proposal-authorization-test: ok");
  } finally {
    await db?.$disconnect();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
