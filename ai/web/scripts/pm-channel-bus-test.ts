import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { promisify } from "node:util";
import { strict as assert } from "node:assert";

const execFileP = promisify(execFile);

type BusEnvelope = {
  schema: 1;
  kind: "openclaw.pm_channel_turn";
  target: { kind: "direct"; agentSlug: string; messageId: string };
  payload: { gatewayPort: number; text: string; sessionKey: string };
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
  } = await import("@/lib/agents/pm-channel-jobs");

  const nonce = `bus-${Date.now()}`;
  const target = { kind: "direct" as const, agentSlug: "asdrubal", messageId: nonce };
  const targetKey = `direct:asdrubal:${nonce}`;

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

    const outcome = await runPmChannelWorkerOnce(`test:${nonce}`);
    assert.equal(outcome.claimed, true);
    if (outcome.claimed) assert.equal(outcome.ok, true);

    const run = await db.pmChannelRun.findUniqueOrThrow({
      where: { targetKey },
      select: { id: true, status: true, httpStatus: true },
    });
    assert.equal(run.status, "accepted");
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
      dedupeKey: `openclaw.pm_channel_turn:${nonce}`,
      targetSlug: "asdrubal",
    });
    assert.equal(delivered.length, 1, "consumer must dispatch exactly one PM-channel turn");
    assert.equal((delivered[0] as BusEnvelope["payload"]).text, "hello over bus");
    assert.equal((delivered[0] as BusEnvelope["payload"]).sessionKey, `test:${nonce}`);

    await db.pmChannelRun.deleteMany({ where: { targetKey } });
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
