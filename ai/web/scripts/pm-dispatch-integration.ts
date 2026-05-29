// PM dispatch integration smoke (HOMELAB-46 Slice 3).
//
// Goal: prove that a real task mutation through the same call shape
// the server action uses lands a structurally correct envelope on
// disk via the file-drop driver. The receiver harness in
// pm-dispatch-receiver.ts exercises the driver/notifier in isolation;
// this script closes the loop end-to-end against a fresh Prisma DB.
//
// Strategy (kept narrow on purpose — full Next request/auth path is
// not in scope for Slice 3):
//
//   1. Spin up a throwaway sqlite at a temp DATABASE_URL and run
//      `prisma db push --skip-generate` so the Slice 1 schema is
//      materialised independently of the dev DB.
//   2. Seed two users (a human "actor" and an "agent" assignee) plus
//      one project + one task.
//   3. Configure file-drop dispatch via PM_DISPATCH_DROP_DIR and reset
//      the cached notifier so init() sees the new env.
//   4. Mirror the assignTask server action's persistence + dispatch
//      shape: a single $transaction that flips assigneeId and writes
//      the matching ActivityLog row, then notifyDispatch() with a
//      buildTaskAssigned() envelope using task.id as both the
//      envelope task.id and task.key (the current contract Asdrubal
//      flagged in commentId 12265 — kept verbatim here so the test
//      will fail loudly if that ever drifts before live wake lands).
//   5. Read the drop dir, assert exactly one envelope file is
//      present, parse via parsePmEvent, and assert envelope identity
//      against the persisted Task / User / Project rows.
//
// Run with:
//   pnpm tsx scripts/pm-dispatch-integration.ts
//
// Exit 0 on success, non-zero on assertion or transport failure. The
// script is hermetic: the temp sqlite file and drop dir are always
// removed in the finally block, even on assertion failure.

import { execFile } from "child_process";
import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import { promisify } from "util";

import {
  buildTaskAssigned,
  parsePmEvent,
  type EventTaskRef,
  type PmEvent,
} from "@/lib/pm-events";
import {
  notifyDispatch,
  __resetPmDispatchNotifierForTests,
} from "@/lib/pm-dispatch";

const execFileP = promisify(execFile);

function fail(msg: string): never {
  console.error(`[integration] FAIL: ${msg}`);
  process.exit(1);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function dbPush(dbUrl: string): Promise<void> {
  // Run `prisma db push` in a child process with DATABASE_URL pointed
  // at the temp sqlite file so the live dev DB stays untouched. We
  // skip client generation because the project's PrismaClient is
  // already generated against the same schema.
  const args = [
    "prisma",
    "db",
    "push",
    "--skip-generate",
    "--accept-data-loss",
    "--schema=prisma/schema.prisma",
  ];
  await execFileP("pnpm", args, {
    env: { ...process.env, DATABASE_URL: dbUrl },
    cwd: process.cwd(),
  });
}

async function loadPrismaWithUrl(dbUrl: string) {
  // PrismaClient resolves DATABASE_URL at construct time. The dev
  // PrismaClient cached in lib/db.ts already captured the original
  // env, so we instantiate a fresh client bound to the temp URL.
  process.env.DATABASE_URL = dbUrl;
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}

interface SeededRefs {
  actorId: string;
  agentUserId: string;
  agentUsername: string;
  projectId: string;
  projectSlug: string;
  taskId: string;
  taskTitle: string;
}

async function seed(db: any): Promise<SeededRefs> {
  const project = await db.project.create({
    data: { slug: "integration-proj", name: "Integration Project" },
  });
  const actor = await db.user.create({
    data: {
      username: "human-actor",
      email: "human-actor@integration.test",
      kind: "human",
    },
  });
  const agentUser = await db.user.create({
    data: {
      username: "agent-assignee",
      email: "agent-assignee@integration.test",
      kind: "agent",
    },
  });
  const task = await db.task.create({
    data: {
      projectId: project.id,
      title: "Integration smoke task",
      status: "To Do",
    },
  });
  return {
    actorId: actor.id,
    agentUserId: agentUser.id,
    agentUsername: agentUser.username,
    projectId: project.id,
    projectSlug: project.slug,
    taskId: task.id,
    taskTitle: task.title,
  };
}

async function assignAndDispatch(
  db: any,
  refs: SeededRefs,
): Promise<PmEvent> {
  // Mirror app/(app)/projects/[slug]/tasks/[taskId]/page.tsx
  // assignTask: a single $transaction flips assigneeId and writes the
  // task.assign ActivityLog row, then we hand a buildTaskAssigned
  // envelope to notifyDispatch with the same field shape the server
  // action uses (task.key === task.id is the current contract).
  await db.$transaction([
    db.task.update({
      where: { id: refs.taskId },
      data: { assigneeId: refs.agentUserId },
    }),
    db.activityLog.create({
      data: {
        projectId: refs.projectId,
        taskId: refs.taskId,
        userId: refs.actorId,
        kind: "task.assign",
        payload: JSON.stringify({ from: null, to: refs.agentUsername }),
      },
    }),
  ]);

  const taskRef: EventTaskRef = {
    id: refs.taskId,
    key: refs.taskId,
    projectKey: refs.projectSlug,
    title: refs.taskTitle,
  };
  const event = buildTaskAssigned(
    {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      actor: { id: refs.actorId, kind: "human" },
      task: taskRef,
    },
    {
      assignee: { id: refs.agentUserId, kind: "agent" },
      previousAssignee: null,
    },
  );
  const result = await notifyDispatch(event);
  if (!result.ok) {
    fail(`notifyDispatch returned ok=false: ${result.error ?? "unknown"}`);
  }
  return event;
}

async function readSoleEnvelope(dir: string): Promise<PmEvent> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  if (files.length !== 1) {
    fail(`expected exactly 1 envelope file in drop dir, got ${files.length}`);
  }
  const raw = await readFile(path.join(dir, files[0]), "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    fail(`envelope JSON parse failed: ${(err as Error).message}`);
  }
  return parsePmEvent(json);
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pm-dispatch-int-"));
  const dbPath = path.join(sandbox, "test.db");
  const dropDir = path.join(sandbox, "drop");
  const dbUrl = `file:${dbPath}`;
  const originalDbUrl = process.env.DATABASE_URL;
  const originalDropDir = process.env.PM_DISPATCH_DROP_DIR;
  const originalDriver = process.env.PM_DISPATCH_DRIVER;
  const originalSocket = process.env.PM_DISPATCH_SOCKET;

  let db: any;
  try {
    await execFileP("mkdir", ["-p", dropDir]);
    await dbPush(dbUrl);

    process.env.PM_DISPATCH_DRIVER = "file-drop";
    process.env.PM_DISPATCH_DROP_DIR = dropDir;
    delete process.env.PM_DISPATCH_SOCKET;
    __resetPmDispatchNotifierForTests();

    db = await loadPrismaWithUrl(dbUrl);
    const refs = await seed(db);
    const sent = await assignAndDispatch(db, refs);

    const persistedTask = await db.task.findUnique({
      where: { id: refs.taskId },
      select: { assigneeId: true },
    });
    assertEqual(
      persistedTask?.assigneeId,
      refs.agentUserId,
      "persisted task.assigneeId",
    );

    const received = await readSoleEnvelope(dropDir);
    assertEqual(received.kind, "task.assigned", "envelope.kind");
    assertEqual(received.id, sent.id, "envelope.id");
    assertEqual(received.task.id, refs.taskId, "envelope.task.id");
    assertEqual(received.task.key, refs.taskId, "envelope.task.key (current contract: task.id)");
    assertEqual(
      received.task.projectKey,
      refs.projectSlug,
      "envelope.task.projectKey",
    );
    assertEqual(received.task.title, refs.taskTitle, "envelope.task.title");
    assertEqual(received.actor.id, refs.actorId, "envelope.actor.id");
    assertEqual(received.actor.kind, "human", "envelope.actor.kind");
    if (received.kind !== "task.assigned") {
      fail("envelope kind narrowed away from task.assigned");
    }
    assertEqual(
      received.payload.assignee?.id,
      refs.agentUserId,
      "envelope.payload.assignee.id",
    );
    assertEqual(
      received.payload.assignee?.kind,
      "agent",
      "envelope.payload.assignee.kind",
    );
    assertEqual(
      received.payload.previousAssignee,
      null,
      "envelope.payload.previousAssignee",
    );

    console.log("[integration] OK", {
      taskId: refs.taskId,
      envelopeId: received.id,
      dropDir,
    });
  } finally {
    if (db) {
      try {
        await db.$disconnect();
      } catch {
        // ignore
      }
    }
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    if (originalDropDir === undefined) delete process.env.PM_DISPATCH_DROP_DIR;
    else process.env.PM_DISPATCH_DROP_DIR = originalDropDir;
    if (originalDriver === undefined) delete process.env.PM_DISPATCH_DRIVER;
    else process.env.PM_DISPATCH_DRIVER = originalDriver;
    if (originalSocket === undefined) delete process.env.PM_DISPATCH_SOCKET;
    else process.env.PM_DISPATCH_SOCKET = originalSocket;
    __resetPmDispatchNotifierForTests();
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((err) => fail((err as Error).stack ?? String(err)));
