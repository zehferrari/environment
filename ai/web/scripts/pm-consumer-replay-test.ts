// HOMELAB-46 Slice 4 acceptance: replay-test.
//
// Strategy (hermetic, no real gateway needed):
//   1. Spin up a throwaway sqlite at a temp DATABASE_URL and apply
//      the Slice 4 schema via `prisma db push`.
//   2. Stand up a mock gateway HTTP server on 127.0.0.1:<random>
//      that records every /hooks/wake call and acks 200.
//   3. Start the consumer with a temp socket + temp drop dir +
//      stubbed PM_CONSUMER_HOOK_TOKEN_<SLUG> bearer.
//   4. Seed a project + human actor + agent assignee (matching
//      /srv/agents/index.json's "barekbaal" slug — the slug, not the
//      User row, is what the wakeable agent maps to). Override the
//      index loader so the resolver sees only the seeded agent and
//      points its gateway_port at the mock server's port.
//   5. Fire the same envelope twice — once via socket, once via
//      file-drop — and assert: exactly one wake recorded by the mock
//      gateway, exactly one PmEventDelivery row with deliveryStatus=
//      "delivered", and one ActivityLog row with
//      kind="agent.wake.delivered" plus one with
//      kind="agent.wake.skipped-duplicate".
//
// Exit 0 on success, non-zero on assertion or transport failure.

import { execFile } from "child_process";
import { mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { createConnection, createServer as netCreateServer } from "net";
import { createServer as httpCreateServer, type Server as HttpServer } from "http";

const execFileP = promisify(execFile);

function fail(msg: string): never {
  console.error(`[replay-test] FAIL: ${msg}`);
  process.exit(1);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    [
      "prisma",
      "db",
      "push",
      "--skip-generate",
      "--accept-data-loss",
      "--schema=prisma/schema.prisma",
    ],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

async function loadPrismaWithUrl(dbUrl: string) {
  process.env.DATABASE_URL = dbUrl;
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}

interface MockGateway {
  port: number;
  hits: Array<{ slug: string; body: any }>;
  stop: () => Promise<void>;
}

async function startMockGateway(): Promise<MockGateway> {
  const hits: MockGateway["hits"] = [];
  const server: HttpServer = httpCreateServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/hooks/wake") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        hits.push({ slug: "barekbaal", body: parsed });
      } catch {
        hits.push({ slug: "barekbaal", body: null });
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    hits,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function sendOverSocket(sockPath: string, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const conn = createConnection(sockPath, () => {
      conn.end(line + "\n", () => resolve());
    });
    conn.once("error", reject);
  });
}

async function waitForDeliveryRow(db: any, dedupeKey: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const row = await db.pmEventDelivery.findUnique({ where: { dedupeKey } });
    if (row) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  fail(`PmEventDelivery row for dedupeKey=${dedupeKey} never appeared`);
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pm-consumer-replay-"));
  const dbPath = path.join(sandbox, "test.db");
  const sockPath = path.join(sandbox, "events.sock");
  const dropDir = path.join(sandbox, "drop");
  const dbUrl = `file:${dbPath}`;
  const original = {
    DATABASE_URL: process.env.DATABASE_URL,
    PM_CONSUMER_SOCKET: process.env.PM_CONSUMER_SOCKET,
    PM_CONSUMER_DROP_DIR: process.env.PM_CONSUMER_DROP_DIR,
    PM_CONSUMER_HOOK_TOKEN_BAREKBAAL:
      process.env.PM_CONSUMER_HOOK_TOKEN_BAREKBAAL,
    PM_CONSUMER_HOOK_TOKEN_FILE: process.env.PM_CONSUMER_HOOK_TOKEN_FILE,
    AGENT_INDEX_PATH: process.env.AGENT_INDEX_PATH,
  };

  let db: any;
  let mock: MockGateway | undefined;
  let consumerStop: (() => Promise<void>) | undefined;

  try {
    await execFileP("mkdir", ["-p", dropDir]);
    await dbPush(dbUrl);

    mock = await startMockGateway();

    // Pinned agent index so the resolver sees exactly one agent
    // pointed at the mock gateway port.
    const agentIndexPath = path.join(sandbox, "agents-index.json");
    await writeFile(
      agentIndexPath,
      JSON.stringify({
        version: 1,
        codeOwner: "zeh",
        agents: [
          {
            user: "barekbaal",
            name: "Barekbaal Irwin",
            role: "coding",
            enabled: true,
            listeners: [
              {
                host: "127.0.0.1",
                port: mock.port,
                owner: "openclaw-gateway",
                expected: true,
              },
            ],
          },
        ],
      }),
    );

    process.env.PM_CONSUMER_SOCKET = sockPath;
    process.env.PM_CONSUMER_DROP_DIR = dropDir;
    process.env.PM_CONSUMER_HOOK_TOKEN_BAREKBAAL = "test-token";
    delete process.env.PM_CONSUMER_HOOK_TOKEN_FILE;
    process.env.AGENT_INDEX_PATH = agentIndexPath;

    db = await loadPrismaWithUrl(dbUrl);

    // Seed: project + actor + agent row + agent-user row + task.
    const project = await db.project.create({
      data: { slug: "replay-proj", name: "Replay Project" },
    });
    const actor = await db.user.create({
      data: {
        username: "actor-h",
        email: "actor-h@replay.test",
        kind: "human",
      },
    });
    const agentRow = await db.agent.create({
      data: {
        slug: "barekbaal",
        name: "Barekbaal Irwin",
        role: "coding",
        gatewayPort: mock.port,
      },
    });
    const agentUser = await db.user.create({
      data: {
        username: "barekbaal",
        email: "barekbaal@replay.test",
        kind: "agent",
        agentId: agentRow.id,
      },
    });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Replay smoke task",
        status: "To Do",
        assigneeId: agentUser.id,
      },
    });

    // Build the envelope manually (no need for the producer-side
    // builders here — we just need a wire-shape PmEvent).
    const envelope = {
      schema: 1,
      id: randomUUID(),
      kind: "task.assigned",
      occurredAt: new Date().toISOString(),
      actor: { id: actor.id, kind: "human" as const },
      task: {
        id: task.id,
        key: task.id,
        projectKey: project.slug,
        title: task.title,
      },
      payload: {
        assignee: { id: agentUser.id, kind: "agent" as const },
        previousAssignee: null,
      },
    };

    const { startService } = await import("@/lib/pm-consumer");
    const handle = await startService({
      socketPath: sockPath,
      dropDir,
      onOutcome: (o, src) => {
        console.log(`[replay-test] ${src} outcome: ${o.kind}`);
      },
    });
    consumerStop = handle.stop;

    // First fire: over the socket.
    await sendOverSocket(sockPath, JSON.stringify(envelope));
    const expectedDedupe = `task.assigned:${task.id}:${envelope.id}`;
    await waitForDeliveryRow(db, expectedDedupe);

    // Second fire: same envelope, this time via file-drop. The drop
    // filename includes a UUID so we don't collide on disk.
    const dropFile = path.join(
      dropDir,
      `${envelope.occurredAt.replace(/[:.]/g, "-")}-replay-2.json`,
    );
    const tmpFile = `${dropFile}.tmp`;
    await writeFile(tmpFile, JSON.stringify(envelope) + "\n");
    await execFileP("mv", [tmpFile, dropFile]);

    // Give the file-drop listener time to scan + process.
    await new Promise((r) => setTimeout(r, 800));

    // --- Assertions ---
    const deliveries = await db.pmEventDelivery.findMany();
    assertEqual(deliveries.length, 1, "PmEventDelivery row count (UNIQUE dedupeKey)");
    assertEqual(deliveries[0].dedupeKey, expectedDedupe, "dedupeKey");
    assertEqual(
      deliveries[0].deliveryStatus,
      "delivered",
      "deliveryStatus on the surviving row",
    );
    assertEqual(
      deliveries[0].targetAgentSlug,
      "barekbaal",
      "targetAgentSlug",
    );
    assertEqual(
      deliveries[0].targetGatewayPort,
      mock.port,
      "targetGatewayPort",
    );

    assertEqual(
      mock.hits.length,
      1,
      "mock gateway hit count (exactly one wake under replay)",
    );

    const audits = await db.activityLog.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
    });
    const auditKinds = audits.map((a: any) => a.kind);
    assertEqual(
      auditKinds.filter((k: string) => k === "agent.wake.delivered").length,
      1,
      "agent.wake.delivered audit count",
    );
    assertEqual(
      auditKinds.filter((k: string) => k === "agent.wake.skipped-duplicate").length,
      1,
      "agent.wake.skipped-duplicate audit count",
    );

    console.log("[replay-test] OK", {
      dedupeKey: expectedDedupe,
      mockGatewayHits: mock.hits.length,
      deliveries: deliveries.length,
      auditRows: audits.length,
    });
  } finally {
    if (consumerStop) {
      try {
        await consumerStop();
      } catch {
        // ignore
      }
    }
    if (mock) {
      try {
        await mock.stop();
      } catch {
        // ignore
      }
    }
    if (db) {
      try {
        await db.$disconnect();
      } catch {
        // ignore
      }
    }
    for (const k of Object.keys(original) as Array<keyof typeof original>) {
      const v = original[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((err) => fail((err as Error).stack ?? String(err)));
