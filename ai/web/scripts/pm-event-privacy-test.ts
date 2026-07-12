import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import type { WakeArgs } from "../lib/pm-consumer/gateway-client";

const execFileP = promisify(execFile);

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "pm-event-privacy-"));
  const originalDbUrl = process.env.DATABASE_URL;
  let db: PrismaClient | undefined;

  try {
    const dbUrl = `file:${path.join(tmp, "test.db")}`;
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;

    const [dbMod, events, visibility, consumer] = await Promise.all([
      import("../lib/db"),
      import("../lib/pm-events"),
      import("../lib/pm-events/visibility"),
      import("../lib/pm-consumer/handler"),
    ]);
    db = dbMod.db as PrismaClient;
    const prisma = db;

    const owner = await prisma.user.create({
      data: {
        username: "event-privacy-owner",
        email: "event-privacy-owner@example.test",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const member = await prisma.user.create({
      data: {
        username: "event-privacy-member",
        email: "event-privacy-member@example.test",
        kind: "human",
        mustRotatePassword: false,
      },
    });
    const workflowAgent = await prisma.agent.create({
      data: { slug: "event-privacy-workflow-agent", name: "Event Privacy Workflow Agent", role: "coding" },
    });
    const workflowAgentUser = await prisma.user.create({
      data: {
        username: workflowAgent.slug,
        email: "event-privacy-workflow-agent@example.test",
        kind: "agent",
        agentId: workflowAgent.id,
        mustRotatePassword: false,
      },
    });
    const project = await prisma.project.create({
      data: { slug: "event-privacy", name: "Event privacy" },
    });
    const publicTask = await prisma.task.create({
      data: {
        projectId: project.id,
        title: "Public task",
        assigneeId: workflowAgentUser.id,
      },
    });
    const privateTask = await prisma.task.create({
      data: { projectId: project.id, title: "SECRET private task", private: true },
    });
    const privateEpic = await prisma.epic.create({
      data: { projectId: project.id, title: "SECRET private epic", private: true },
    });
    const publicTaskInPrivateEpic = await prisma.task.create({
      data: {
        projectId: project.id,
        epicId: privateEpic.id,
        title: "SECRET task under private epic",
      },
    });
    const privateParent = await prisma.task.create({
      data: { projectId: project.id, title: "SECRET private parent", private: true },
    });
    const publicChildOfPrivateParent = await prisma.task.create({
      data: {
        projectId: project.id,
        parentTaskId: privateParent.id,
        title: "SECRET child under private parent",
      },
    });

    assert.equal(await visibility.isEffectivelyPublicTask(publicTask.id), true, "public task is event-visible");
    assert.equal(await visibility.isEffectivelyPublicTask(privateTask.id), false, "private task is event-hidden");
    assert.equal(await visibility.isEffectivelyPublicTask(publicTaskInPrivateEpic.id), false, "task in private Epic is event-hidden");
    assert.equal(await visibility.isEffectivelyPublicTask(publicChildOfPrivateParent.id), false, "task under private parent is event-hidden");
    assert.equal(await visibility.isPublicEpic(privateEpic.id), false, "private Epic is event-hidden");

    const ownerActor = { id: owner.id, kind: "human" as const };
    const memberActor = { id: member.id, kind: "human" as const };
    const assignedEvent = (
      task: { id: string; title: string },
      actor = ownerActor,
    ) => events.buildTaskAssigned(
      {
        id: `assigned-${task.id}`,
        occurredAt: new Date().toISOString(),
        actor,
        task: { id: task.id, key: task.id, projectKey: project.slug, title: task.title },
      },
      { assignee: { id: "event-privacy-agent", kind: "agent" as const }, previousAssignee: null },
    );
    const privateDeployment = events.buildDeploymentApproved(
      {
        id: `deployment-${privateEpic.id}`,
        occurredAt: new Date().toISOString(),
        actor: ownerActor,
        task: {
          id: privateEpic.id,
          key: privateEpic.id,
          projectKey: project.slug,
          title: privateEpic.title,
        },
      },
      { scope: "epic", scopeId: privateEpic.id, deploymentStatus: "Deployment Approved" },
    );

    assert.equal(await visibility.isEffectivelyPublicPmEvent(assignedEvent(privateTask)), false, "private task envelope is rejected by current visibility");
    assert.equal(await visibility.isEffectivelyPublicPmEvent(privateDeployment), false, "private Epic deployment envelope is rejected by current visibility");

    const wakes: WakeArgs[] = [];
    const handler = consumer.createHandler({
      resolver: {
        resolve: async () => ({ slug: "event-privacy-agent", gatewayPort: 45678, reason: "assignee" as const }),
      },
      wake: async (args: WakeArgs) => {
        wakes.push(args);
        return { ok: true, status: 200, driver: "gateway-http" };
      },
    });

    const privateTaskOutcome = await handler.handle(assignedEvent(privateTask));
    assert.equal(privateTaskOutcome.kind, "skipped-private", "consumer skips private task before resolving or waking an agent");
    const privateEpicOutcome = await handler.handle(privateDeployment);
    assert.equal(privateEpicOutcome.kind, "skipped-private", "consumer skips private Epic deployment before monitor delivery");
    assert.equal(wakes.length, 0, "private event titles never reach the agent wake call");
    assert.equal(await prisma.pmEventDelivery.count(), 0, "private event envelopes are never persisted in the delivery log");

    const memberAssigned = await handler.handle(assignedEvent(publicTask, memberActor));
    assert.equal(memberAssigned.kind, "skipped-unauthorized", "a non-owner cannot trigger a legacy task-assigned wake");
    const memberMentioned = await handler.handle(events.buildTaskMentioned(
      {
        id: "mentioned-by-member",
        occurredAt: new Date().toISOString(),
        actor: memberActor,
        task: { id: publicTask.id, key: publicTask.id, projectKey: project.slug, title: publicTask.title },
      },
      {
        commentId: "member-comment",
        mentioned: { id: "event-privacy-agent", kind: "agent" },
        bodyMarkdown: "@event-privacy-agent do this",
      },
    ));
    assert.equal(memberMentioned.kind, "skipped-unauthorized", "a non-owner cannot trigger a legacy mention wake");
    const memberChat = await handler.handle(events.buildTaskAgentChat(
      {
        id: "chat-by-member",
        occurredAt: new Date().toISOString(),
        actor: memberActor,
        task: { id: publicTask.id, key: publicTask.id, projectKey: project.slug, title: publicTask.title },
      },
      {
        chatMessageId: "member-chat",
        targetAgentSlug: "event-privacy-agent",
        userMessage: "Do this work",
        allowDescriptionEdit: false,
        currentDescription: null,
        systemPrompt: "",
        replyEndpoint: null,
      },
    ));
    assert.equal(memberChat.kind, "skipped-unauthorized", "a non-owner cannot trigger a legacy agent-chat wake");
    const memberDeployment = await handler.handle(events.buildDeploymentApproved(
      {
        id: "deployment-by-member",
        occurredAt: new Date().toISOString(),
        actor: memberActor,
        task: { id: publicTask.id, key: publicTask.id, projectKey: project.slug, title: publicTask.title },
      },
      { scope: "task", scopeId: publicTask.id, deploymentStatus: "Deployment Approved" },
    ));
    assert.equal(memberDeployment.kind, "skipped-unauthorized", "a non-owner cannot trigger legacy deployment handling");
    assert.equal(wakes.length, 0, "non-owner legacy events never wake an agent");
    assert.equal(await prisma.pmEventDelivery.count(), 0, "unauthorized events are not persisted into delivery history");

    const systemAckId = "agent-workflow-ack";
    await prisma.activityLog.create({
      data: {
        projectId: project.id,
        taskId: publicTask.id,
        userId: workflowAgentUser.id,
        kind: "task.ack.auto",
        payload: JSON.stringify({ from: "To Do", to: "In Progress", pmEventId: systemAckId }),
      },
    });
    const systemAck = await handler.handle(events.buildTaskAckReady(
      {
        id: systemAckId,
        occurredAt: new Date().toISOString(),
        actor: { id: workflowAgentUser.id, kind: "agent" },
        task: { id: publicTask.id, key: publicTask.id, projectKey: project.slug, title: publicTask.title },
      },
      { reason: "auto-transition", fromStatus: "To Do", toStatus: "In Progress" },
    ));
    assert.equal(systemAck.kind, "delivered", "explicit agent workflow events remain deliverable");
    assert.equal(wakes.length, 1, "the agent workflow continuation still wakes its target");

    const forgedAgentAck = await handler.handle(events.buildTaskAckReady(
      {
        id: "forged-agent-workflow-ack",
        occurredAt: new Date().toISOString(),
        actor: { id: workflowAgentUser.id, kind: "agent" },
        task: { id: publicTask.id, key: publicTask.id, projectKey: project.slug, title: publicTask.title },
      },
      { reason: "auto-transition", fromStatus: "To Do", toStatus: "In Progress" },
    ));
    assert.equal(forgedAgentAck.kind, "skipped-unauthorized", "an active agent id alone cannot forge a legacy workflow wake");
    assert.equal(wakes.length, 1, "forged agent envelopes never wake a target");

    const publicOutcome = await handler.handle(assignedEvent(publicTask));
    assert.equal(publicOutcome.kind, "delivered", "public task event still reaches its agent");
    assert.equal(wakes.length, 2, "owner task event wakes its agent after the system continuation");
    assert.match(wakes[1]!.text, /Public task/, "public task title remains available to its agent");

    console.log("pm-event-privacy-test: ok");
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
