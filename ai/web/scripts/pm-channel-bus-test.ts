import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { promisify } from "node:util";
import { strict as assert } from "node:assert";

const execFileP = promisify(execFile);

type BusEnvelope = {
  schema: 1;
  id: string;
  kind: "openclaw.pm_channel_turn";
  target: Record<string, unknown>;
  payload: { gatewayPort: number | null; text: string; sessionKey: string; [key: string]: unknown };
};

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

async function main() {
  const sandbox = await mkdtemp(join(tmpdir(), "pm-channel-bus-db-"));
  const dropDir = await mkdtemp(join(tmpdir(), "pm-channel-bus-"));
  const dbUrl = `file:${join(sandbox, "test.db")}`;

  process.env.DATABASE_URL = dbUrl;
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.PM_CHANNEL_BUS_DROP_DIR = dropDir;
  delete process.env.PM_OPENCLAW_CHANNEL_HTTP_FALLBACK;

  await dbPush(dbUrl);

  const { db } = await import("@/lib/db");
  const {
    runPmChannelWorkerOnce,
    sendOrQueueOpenClawPmChannelTurn,
  } = await import("@/lib/agents/pm-channel/jobs");

  // Delivery revalidates the human sender as the active Mission Control
  // owner. This fresh sandbox models that authorized browser-origin turn.
  await db.user.create({
    data: {
      id: "human-test",
      username: "human-test",
      email: "human-test@example.test",
      kind: "human",
      isOwner: true,
      mustRotatePassword: false,
    },
  });

  const nonce = `bus-${Date.now()}`;
  const target = { kind: "direct" as const, agentSlug: "asdrubal", messageId: nonce };
  const targetKey = `direct:asdrubal:${nonce}`;

  await db.directAgentChatMessage.create({
    data: {
      id: nonce,
      agentSlug: target.agentSlug,
      senderUserId: "human-test",
      body: "hello over bus",
    },
  });

  try {
    await db.pmChannelRun.deleteMany({ where: { targetKey } });

    const queued = await sendOrQueueOpenClawPmChannelTurn({
      gatewayPort: 45678,
      agentSlug: "asdrubal",
      sessionKey: `test:${nonce}`,
      kind: "direct",
      text: "hello over bus",
      actor: { id: "human-test", kind: "human" },
      replyTarget: target,
    });
    assert.equal(queued.ok, true);
    assert.equal(queued.status, 202);

    const queuedRun = await db.pmChannelRun.findUniqueOrThrow({
      where: { targetKey },
      select: {
        id: true,
        streamEvents: { orderBy: { seq: "asc" }, select: { kind: true, payload: true } },
      },
    });
    assert.equal(
      queuedRun.streamEvents.some((event) => {
        if (event.kind !== "status") return false;
        return (JSON.parse(event.payload) as { runStatus?: string }).runStatus === "queued";
      }),
      true,
      "enqueue must durably persist its queued frame before a short-lived producer disconnects Prisma",
    );

    const outcome = await runPmChannelWorkerOnce(`test:${nonce}`);
    assert.equal(outcome.claimed, true);
    if (outcome.claimed) assert.equal(outcome.ok, true);

    const run = await db.pmChannelRun.findUniqueOrThrow({
      where: { targetKey },
      select: { id: true, status: true, httpStatus: true },
    });
    assert.equal(run.status, "delivered");
    assert.equal(run.httpStatus, 202);

    const job = await db.pmChannelJob.findUniqueOrThrow({
      where: { runId: run.id },
      select: { status: true, attemptCount: true, lastError: true },
    });
    assert.equal(job.status, "accepted");
    assert.equal(job.attemptCount, 1);
    assert.equal(job.lastError, null);

    const files = await readdir(dropDir);
    assert.equal(files.length, 1, "bus producer should write exactly one envelope");
    const envelope = JSON.parse(await readFile(join(dropDir, files[0]!), "utf8")) as BusEnvelope;
    assert.equal(envelope.schema, 1);
    assert.equal(envelope.kind, "openclaw.pm_channel_turn");
    assert.deepEqual(envelope.target, target);
    assert.equal(envelope.payload.gatewayPort, 45678);
    assert.equal(envelope.payload.text, "hello over bus");
    assert.equal(envelope.payload.sessionKey, `test:${nonce}`);

    const { isAuthorizedPmChannelDispatchTarget } = await import(
      "@/lib/agents/pm-channel/target-authorization"
    );
    assert.equal(
      await isAuthorizedPmChannelDispatchTarget(envelope.payload as never),
      true,
      "the natural delivered/accepted handoff must remain authorized",
    );

    // A file-drop consumer can race between the publisher recording
    // `delivered` and the worker recording the accepted job outcome. Keep the
    // run on its natural delivered state and model that claimed-job window.
    await db.pmChannelJob.update({
      where: { runId: run.id },
      data: { status: "claimed" },
    });
    assert.equal(
      await isAuthorizedPmChannelDispatchTarget(envelope.payload as never),
      true,
      "the delivered/claimed handoff must remain authorized",
    );

    const { createHandler } = await import("@/lib/pm-consumer/handler");
    const delivered: unknown[] = [];
    const handler = createHandler({
      pmChannelDispatch: async (args) => {
        delivered.push(args);
        return {
          ok: true,
          status: 202,
          driver: "openclaw-pm-channel",
          transportMode: "http",
        };
      },
    });
    const consumerOutcome = await handler.handle(envelope);
    assert.deepEqual(consumerOutcome, {
      kind: "delivered",
      // Envelope id is per-target (agent slug + scope + message), so a
      // broadcast reusing one message id never collapses to one agent.
      dedupeKey: `openclaw.pm_channel_turn:${targetKey}`,
      targetSlug: "asdrubal",
    });
    assert.equal(delivered.length, 1, "consumer must dispatch exactly one PM-channel turn");
    assert.equal((delivered[0] as BusEnvelope["payload"]).text, "hello over bus");
    assert.equal((delivered[0] as BusEnvelope["payload"]).sessionKey, `test:${nonce}`);

    const tampered = {
      ...envelope,
      payload: { ...envelope.payload, text: "forged bus content" },
    };
    const tamperedOutcome = await handler.handle(tampered);
    assert.equal(tamperedOutcome.kind, "skipped-unauthorized", "bus payload must match the durable dispatch job");
    assert.equal(delivered.length, 1, "a tampered envelope must never reach the agent");

    // A durable file-drop can arrive after a newer generation superseded the
    // run that published it. It must be fenced before dispatch even when its
    // stale job still says accepted — the production failure this guards used
    // to resurrect the dead run and collide with the active-lane index.
    await db.$transaction([
      db.pmChannelRun.update({ where: { id: run.id }, data: { status: "superseded" } }),
      db.pmChannelJob.update({ where: { runId: run.id }, data: { status: "accepted" } }),
    ]);
    const staleOutcome = await handler.handle(envelope);
    assert.equal(staleOutcome.kind, "skipped-unauthorized", "a terminal run's delayed envelope is fenced");
    assert.equal(delivered.length, 1, "a stale durable envelope never reaches the agent");

    // A non-owner's source message is not a valid bus origin even when its
    // target/run/job fields are otherwise correct.
    const { publishPmChannelTurnToBus } = await import("@/lib/agents/pm-channel/bus");
    const member = await db.user.create({
      data: {
        username: "bus-member",
        email: "bus-member@example.test",
        kind: "human",
        mustRotatePassword: false,
      },
    });
    const memberNonce = `bus-member-${Date.now()}`;
    const memberTarget = { kind: "direct" as const, agentSlug: "asdrubal", messageId: memberNonce };
    const memberArgs = {
      gatewayPort: 45678,
      agentSlug: memberTarget.agentSlug,
      sessionKey: `test:${memberNonce}`,
      kind: "direct" as const,
      text: "member bus message",
      actor: { id: member.id, kind: "human" as const },
      replyTarget: memberTarget,
    };
    await db.directAgentChatMessage.create({
      data: {
        id: memberNonce,
        agentSlug: memberTarget.agentSlug,
        senderUserId: member.id,
        body: memberArgs.text,
      },
    });
    const memberRun = await db.pmChannelRun.create({
      data: {
        targetKey: `direct:${memberTarget.agentSlug}:${memberTarget.messageId}`,
        kind: memberArgs.kind,
        agentSlug: memberArgs.agentSlug,
        messageId: memberTarget.messageId,
        sessionKey: memberArgs.sessionKey,
        gatewayPort: memberArgs.gatewayPort,
        status: "queued",
      },
    });
    await db.pmChannelJob.create({
      data: {
        runId: memberRun.id,
        agentSlug: memberArgs.agentSlug,
        kind: memberArgs.kind,
        payload: JSON.stringify(memberArgs),
        status: "claimed",
      },
    });
    const memberPublished = await publishPmChannelTurnToBus(memberArgs);
    assert.equal(memberPublished.ok, true, "member envelope is written for consumer authorization testing");
    const memberRaw = JSON.parse(await readFile((memberPublished.receipt as { path: string }).path, "utf8"));
    const memberOutcome = await handler.handle(memberRaw);
    assert.equal(memberOutcome.kind, "skipped-unauthorized", "non-owner direct messages cannot enter the native PM channel");
    assert.equal(delivered.length, 1, "non-owner native turns never dispatch to an agent");

    // PM-generated Epic workflow turns use an active agent (normally the
    // Monitor fallback) as their sender. The durable epic.workflow.notify row
    // is the narrow authorization grant; requiring a human owner here would
    // silently drop whole-Epic acceptance reviews at the consumer boundary.
    const monitorAgent = await db.agent.create({
      data: { slug: "karen", name: "Karen", role: "monitor" },
    });
    const monitor = await db.user.create({
      data: {
        username: "karen",
        email: "karen@example.test",
        kind: "agent",
        agentId: monitorAgent.id,
      },
    });
    const epicProject = await db.project.create({
      data: { slug: `epic-bus-${Date.now()}`, name: "Epic Bus Test" },
    });
    const epic = await db.epic.create({
      data: { projectId: epicProject.id, title: "Whole-Epic acceptance", status: "Review" },
    });
    const epicMessageId = `epic-workflow-${Date.now()}`;
    const epicTarget = {
      kind: "epic-chat" as const,
      agentSlug: "karen",
      epicId: epic.id,
      messageId: epicMessageId,
      projectSlug: epicProject.slug,
    };
    const epicArgs = {
      gatewayPort: 45678,
      agentSlug: "karen",
      sessionKey: `test:${epicMessageId}:karen`,
      kind: "epic-chat" as const,
      text: "review the frozen Epic candidate",
      actor: { id: monitor.id, kind: "agent" as const },
      replyTarget: epicTarget,
      projectId: epicProject.id,
    };
    await db.agentChatMessage.create({
      data: {
        id: epicMessageId,
        projectId: epicProject.id,
        epicId: epic.id,
        agentSlug: "room",
        senderUserId: monitor.id,
        body: epicArgs.text,
        targetType: "agent",
        targetValue: "agent:karen",
      },
    });
    await db.activityLog.create({
      data: {
        projectId: epicProject.id,
        userId: monitor.id,
        kind: "epic.workflow.notify",
        targetAgent: "karen",
        payload: JSON.stringify({ messageId: epicMessageId, epicId: epic.id, agentSlug: "karen" }),
      },
    });
    const epicRun = await db.pmChannelRun.create({
      data: {
        targetKey: `epic-chat:karen:${epic.id}:${epicMessageId}`,
        kind: epicArgs.kind,
        agentSlug: epicArgs.agentSlug,
        messageId: epicMessageId,
        epicId: epic.id,
        projectId: epicProject.id,
        sessionKey: epicArgs.sessionKey,
        gatewayPort: epicArgs.gatewayPort,
        status: "queued",
      },
    });
    await db.pmChannelJob.create({
      data: {
        runId: epicRun.id,
        agentSlug: epicArgs.agentSlug,
        kind: epicArgs.kind,
        payload: JSON.stringify(epicArgs),
        status: "claimed",
      },
    });
    const epicPublished = await publishPmChannelTurnToBus(epicArgs);
    assert.equal(epicPublished.ok, true);
    const epicRaw = JSON.parse(await readFile((epicPublished.receipt as { path: string }).path, "utf8"));
    const epicOutcome = await handler.handle(epicRaw);
    assert.equal(epicOutcome.kind, "delivered", "audited Monitor-origin Epic workflow turn must reach the reviewer");
    assert.equal(delivered.length, 2, "Epic workflow authorization must add exactly one delivery");
    await db.pmChannelRun.update({ where: { id: epicRun.id }, data: { status: "accepted" } });
    const { isAuthorizedPmChannelCallbackTarget } = await import(
      "@/lib/agents/pm-channel/target-authorization"
    );
    assert.equal(
      await isAuthorizedPmChannelCallbackTarget(epicTarget),
      true,
      "the same audited Epic workflow origin must authorize stream callbacks",
    );

    // Broadcast case: the SAME room-chat message id fanned out to two agents
    // must produce two distinct envelopes, both delivered. The source remains
    // one owner-authored room message; each addressed agent gets its own
    // durable claimed run/job pair.
    const broadcastNonce = `bus-broadcast-${Date.now()}`;
    const broadcastProject = await db.project.create({
      data: { slug: `bus-project-${Date.now()}`, name: "Bus Test Project" },
    });
    const broadcastTask = await db.task.create({
      data: { projectId: broadcastProject.id, title: "Broadcast task" },
    });
    await db.agentChatMessage.create({
      data: {
        id: broadcastNonce,
        projectId: broadcastProject.id,
        taskId: broadcastTask.id,
        agentSlug: "room",
        senderUserId: "human-test",
        body: "broadcast over bus",
      },
    });
    const broadcastDelivered: string[] = [];
    const broadcastHandler = createHandler({
      pmChannelDispatch: async (args: { agentSlug: string }) => {
        broadcastDelivered.push(args.agentSlug);
        return {
          ok: true,
          status: 202,
          driver: "openclaw-pm-channel",
          transportMode: "http",
        };
      },
    });
    const broadcastEnvelopes: unknown[] = [];
    for (const slug of ["asdrubal", "barekbaal"]) {
      const broadcastTarget = {
        kind: "task-chat" as const,
        agentSlug: slug,
        taskId: broadcastTask.id,
        messageId: broadcastNonce,
        projectSlug: broadcastProject.slug,
      };
      const broadcastArgs = {
        gatewayPort: 45678,
        agentSlug: slug,
        sessionKey: `test:${broadcastNonce}:${slug}`,
        kind: "task-chat" as const,
        text: "broadcast over bus",
        actor: { id: "human-test", kind: "human" as const },
        replyTarget: broadcastTarget,
        projectId: broadcastProject.id,
      };
      const broadcastRun = await db.pmChannelRun.create({
        data: {
          targetKey: `task-chat:${slug}:${broadcastTask.id}:${broadcastNonce}`,
          kind: broadcastArgs.kind,
          agentSlug: slug,
          messageId: broadcastNonce,
          projectId: broadcastProject.id,
          taskId: broadcastTask.id,
          sessionKey: broadcastArgs.sessionKey,
          gatewayPort: broadcastArgs.gatewayPort,
          status: "queued",
        },
      });
      await db.pmChannelJob.create({
        data: {
          runId: broadcastRun.id,
          agentSlug: slug,
          kind: broadcastArgs.kind,
          payload: JSON.stringify(broadcastArgs),
          status: "claimed",
        },
      });
      const published = await publishPmChannelTurnToBus(broadcastArgs);
      assert.equal(published.ok, true, `broadcast publish for ${slug}`);
      const receipt = published.receipt as { path: string };
      broadcastEnvelopes.push(JSON.parse(await readFile(receipt.path, "utf8")));
    }
    const ids = (broadcastEnvelopes as Array<{ id: string }>).map((e) => e.id);
    assert.notEqual(ids[0], ids[1], "broadcast envelopes must carry distinct per-target ids");
    for (const raw of broadcastEnvelopes) {
      const out = await broadcastHandler.handle(raw);
      assert.equal((out as { kind: string }).kind, "delivered", "each broadcast target must be delivered");
    }
    assert.deepEqual(
      broadcastDelivered.sort(),
      ["asdrubal", "barekbaal"],
      "both broadcast agents must be dispatched exactly once",
    );
    const replay = await broadcastHandler.handle(broadcastEnvelopes[0]);
    assert.equal((replay as { kind: string }).kind, "skipped-duplicate", "publisher retry of the same target must dedupe");
    assert.equal(broadcastDelivered.length, 2, "replay must not dispatch again");

    await db.pmChannelRun.deleteMany({ where: { targetKey } });
    await db.pmEventDelivery.deleteMany({ where: { dedupeKey: { contains: broadcastNonce } } });
  } finally {
    delete process.env.PM_CHANNEL_BUS_DROP_DIR;
    await db.$disconnect();
    await rm(dropDir, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log("pm-channel bus tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
