// ENV-124 — the shared harness for the PM workflow regression scenarios.
//
// The Epic's twelve regression cases all need the same three things and nothing
// else: a throwaway database that looks like production, a small cast of rows
// to act on, and a way to drive the REAL workflow route rather than a
// re-implementation of it. This module is that and stops there — every
// assertion about behaviour lives in the scenario files, so a change in what PM
// should do never has to be made here.
//
// Three conventions are inherited from the suites that came before, and each
// one is load-bearing:
//
//   * DATABASE_URL is repointed at a temp file BEFORE any `@/lib/...` import.
//     `@/lib/db` reads it at module-eval time, so a static import at the top of
//     a scenario file would bind the live pm.db. Everything the harness hands
//     back is therefore obtained through `await import(...)` after the sandbox
//     exists — see `bootScenarioDb`.
//     (scripts/workflow-invariants-db-test.ts)
//
//   * `prisma migrate deploy`, not `db push`. The run lifecycle depends on
//     partial unique indexes that only exist in raw-SQL migrations; a pushed
//     schema silently drops them and the supersede/idempotency cases would pass
//     against a database production does not have.
//     (scripts/workflow-watchdog-db-test.ts)
//
//   * `./next-als-polyfill` is imported first so the App Router route handler
//     can be called in-process.
//     (scripts/lib/next-route-harness.ts)
//
// On determinism: the harness seeds ids and timestamps, it does NOT stub the
// global clock. Production code calls `new Date()` inside the transactions
// under test, and replacing it would mean asserting against a fiction. What is
// made deterministic is everything the TEST controls — message ids, seeded row
// timestamps, and relative offsets from a fixed epoch — which is enough to make
// ordering assertions exact without lying about the code path.

import "./next-als-polyfill";

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * A scenario file reports as one suite made of named cases. Case ids are the
 * Epic's own case numbers (C1..C12) so a failure names the regression that
 * broke rather than a line number.
 */
export interface ScenarioCase {
  assert(condition: unknown, label: string): asserts condition;
  assertEqual<T>(actual: T, expected: T, label: string): void;
  assertIncludes(haystack: string | null | undefined, needle: string, label: string): void;
  /** Assert `fn` rejects, and return the error for further inspection. */
  rejects(fn: () => Promise<unknown>, label: string): Promise<unknown>;
}

export interface ScenarioReporter {
  case(id: string, title: string): ScenarioCase;
  /** Print the summary line. Call once, at the end of a passing run. */
  ok(): void;
  /** Fail the suite outright (used by top-level catch handlers). */
  fail(message: string): never;
}

export function createScenarioReporter(suite: string): ScenarioReporter {
  let checks = 0;
  const cases: string[] = [];

  const fail = (message: string): never => {
    console.error(`[${suite}] FAIL: ${message}`);
    process.exit(1);
  };

  return {
    case(id, title) {
      cases.push(id);
      const scope = (label: string) => `${id} (${title}): ${label}`;
      const c: ScenarioCase = {
        assert(condition, label): asserts condition {
          checks += 1;
          if (!condition) fail(scope(label));
        },
        assertEqual(actual, expected, label) {
          checks += 1;
          if (actual !== expected) {
            fail(
              `${scope(label)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
            );
          }
        },
        assertIncludes(haystack, needle, label) {
          checks += 1;
          if (typeof haystack !== "string" || !haystack.includes(needle)) {
            fail(`${scope(label)}: expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
          }
        },
        async rejects(fn, label) {
          checks += 1;
          try {
            await fn();
          } catch (error) {
            return error;
          }
          return fail(`${scope(label)}: expected a rejection, got none`);
        },
      };
      return c;
    },
    ok() {
      console.log(
        `[${suite}] OK — ${checks} assertions across ${cases.length} case(s): ${cases.join(", ")}`,
      );
    },
    fail,
  };
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface ScenarioSandbox {
  dir: string;
  dbUrl: string;
  dispose(): Promise<void>;
}

/**
 * Create the throwaway database and set the process env the scenario needs.
 *
 * MUST be awaited before the scenario imports anything under `@/lib`.
 *
 * `schema: "push"` exists for scenarios that genuinely do not touch the run
 * lifecycle — it is several seconds faster. Anything asserting on run
 * supersede, the partial unique index, or watchdog repairs must stay on the
 * default `"migrate"`.
 */
export async function createScenarioSandbox(args: {
  name: string;
  env?: Record<string, string>;
  schema?: "migrate" | "push";
}): Promise<ScenarioSandbox> {
  const dir = await mkdtemp(path.join(tmpdir(), `${args.name}-`));
  const dbUrl = `file:${path.join(dir, "test.db")}`;

  process.env.DATABASE_URL = dbUrl;
  // The dispatcher must not try to reach a gateway, and the workflow token
  // signer needs a secret. Both are scenario-local.
  process.env.PM_ASYNC_DISPATCH = process.env.PM_ASYNC_DISPATCH ?? "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? `${args.name}-secret`;
  for (const [key, value] of Object.entries(args.env ?? {})) {
    process.env[key] = value;
  }

  const schemaArgs =
    args.schema === "push"
      ? ["db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"]
      : ["migrate", "deploy", "--schema=prisma/schema.prisma"];
  await execFileP("node_modules/.bin/prisma", schemaArgs, {
    env: { ...process.env, DATABASE_URL: dbUrl },
    cwd: process.cwd(),
  });

  return {
    dir,
    dbUrl,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/**
 * Fixed-epoch clock for SEEDED rows. See the module header: production code
 * still calls `new Date()`, and that is deliberate.
 */
export interface ScenarioClock {
  /** The scenario's epoch, in ms. */
  readonly epochMs: number;
  /** A Date `offsetMs` after the epoch. Negative offsets are "in the past". */
  at(offsetMs: number): Date;
  /** Shorthand for `at(-ms)` — how old a row should look right now. */
  ago(ms: number): Date;
}

/** 2026-01-01T00:00:00Z — arbitrary, fixed, and far from any real row. */
const SCENARIO_EPOCH_ISO = "2026-01-01T00:00:00.000Z";

export function createScenarioClock(nowMs: number = Date.now()): ScenarioClock {
  const epochMs = Date.parse(SCENARIO_EPOCH_ISO);
  return {
    epochMs,
    at: (offsetMs: number) => new Date(epochMs + offsetMs),
    // "ago" is relative to the real current time, because the rows it produces
    // are compared against `Date.now()` by the code under test (lease age,
    // stall grace). A fixed epoch there would make every row infinitely stale.
    ago: (ms: number) => new Date(nowMs - ms),
  };
}

/** Monotonic, readable ids: `seq("msg")` → `msg-001`, `msg-002`, ... */
export function createIdSeeder(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n).padStart(3, "0")}`;
  };
}

// ---------------------------------------------------------------------------
// Database boot
// ---------------------------------------------------------------------------

/**
 * The production modules a scenario drives, imported AFTER the sandbox exists.
 *
 * Everything here is a real production entry point. Scenarios deliberately get
 * no test-only writers: a regression that only fails through a helper written
 * for the test is not a regression anybody would have shipped.
 */
export async function bootScenarioDb() {
  const [
    { db },
    runs,
    continuations,
    transactionalAction,
    actionEffect,
    episodes,
    notifications,
  ] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/agents/pm-channel/runs"),
    import("@/lib/agents/pm-channel/continuations"),
    import("@/lib/agents/workflow/transactional-action"),
    import("@/lib/agents/workflow/action-effect"),
    import("@/lib/agents/episodes/lifecycle"),
    import("@/lib/agents/workflow/notifications/task"),
  ]);
  return { db, runs, continuations, transactionalAction, actionEffect, episodes, notifications };
}

export type ScenarioDb = Awaited<ReturnType<typeof bootScenarioDb>>["db"];

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export interface ScenarioWorld {
  agentSlug: string;
  agentId: string;
  agentUserId: string;
  ownerId: string;
  projectId: string;
  epicId: string | null;
}

/**
 * The minimum cast every scenario needs: one coding agent with its user row,
 * one owner human (owner-flagged, because the workflow dispatcher refuses a
 * non-owner human actor), and a project.
 *
 * `withEpic` matters for the Epic-child guards — a task under an Epic that is
 * not In Progress cannot be started.
 */
export async function seedWorld(
  db: ScenarioDb,
  args: {
    agentSlug: string;
    agentName?: string;
    projectSlug: string;
    withEpic?: boolean;
    epicStatus?: string;
  },
): Promise<ScenarioWorld> {
  const agent = await db.agent.create({
    data: { slug: args.agentSlug, name: args.agentName ?? args.agentSlug, role: "coding" },
  });
  const agentUser = await db.user.create({
    data: {
      username: args.agentSlug,
      email: `${args.agentSlug}@example.invalid`,
      kind: "agent",
      agentId: agent.id,
    },
  });
  const owner = await db.user.create({
    data: {
      username: `${args.projectSlug}-owner`,
      email: `${args.projectSlug}-owner@example.invalid`,
      kind: "human",
      isOwner: true,
      mustRotatePassword: false,
    },
  });
  const project = await db.project.create({
    data: { slug: args.projectSlug, name: args.projectSlug },
  });

  let epicId: string | null = null;
  if (args.withEpic) {
    const epic = await db.epic.create({
      data: {
        projectId: project.id,
        title: `${args.projectSlug} epic`,
        status: args.epicStatus ?? "In Progress",
        actingManagerId: owner.id,
      },
    });
    epicId = epic.id;
  }

  return {
    agentSlug: args.agentSlug,
    agentId: agent.id,
    agentUserId: agentUser.id,
    ownerId: owner.id,
    projectId: project.id,
    epicId,
  };
}

/**
 * A second project for the same cast.
 *
 * PM enforces a WIP limit of one In Progress task per agent per PROJECT, and
 * that rule is production behaviour a scenario must not disable. So a suite
 * whose cases each leave a task In Progress gives each case its own project
 * rather than sharing one — which is also the more faithful shape, since real
 * concurrent work is spread across projects.
 */
export async function forkWorldProject(
  db: ScenarioDb,
  world: ScenarioWorld,
  args: { projectSlug: string; withEpic?: boolean; epicStatus?: string },
): Promise<ScenarioWorld> {
  const project = await db.project.create({
    data: { slug: args.projectSlug, name: args.projectSlug },
  });
  let epicId: string | null = null;
  if (args.withEpic) {
    const epic = await db.epic.create({
      data: {
        projectId: project.id,
        title: `${args.projectSlug} epic`,
        status: args.epicStatus ?? "In Progress",
        actingManagerId: world.ownerId,
      },
    });
    epicId = epic.id;
  }
  return { ...world, projectId: project.id, epicId };
}

/** One task per case, so cases never contend for the same rows. */
export async function seedTask(
  db: ScenarioDb,
  world: ScenarioWorld,
  args: {
    title: string;
    status?: string;
    approved?: boolean;
    assigned?: boolean;
    underEpic?: boolean;
    description?: string;
    branchName?: string;
  },
) {
  return db.task.create({
    data: {
      projectId: world.projectId,
      epicId: args.underEpic ? world.epicId : null,
      title: args.title,
      status: args.status ?? "In Progress",
      assigneeId: args.assigned === false ? null : world.agentUserId,
      reporterId: world.ownerId,
      actingManagerId: world.ownerId,
      approvedOn: args.approved === false ? null : new Date(),
      description: args.description ?? args.title,
      branchName: args.branchName ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Driving the real route
// ---------------------------------------------------------------------------

export interface WorkflowResponse {
  status: number;
  body: Record<string, unknown>;
}

export type WorkflowPoster = (
  action: string,
  extra?: Record<string, unknown>,
) => Promise<WorkflowResponse>;

/**
 * POST to `/api/agent/tasks/[taskId]/workflow` in-process, with a real signed
 * grant token.
 *
 * The route is imported, not re-implemented: auth, the rollover barrier, every
 * action branch and the response decorator all run. That is the point — a
 * scenario that bypassed the route would prove nothing about what an agent
 * actually gets back.
 */
export async function makeWorkflowPoster(args: {
  taskId: string;
  messageId: string;
  agentSlug: string;
}): Promise<WorkflowPoster> {
  const [{ runRouteHandler }, { NextRequest }, route, token] = await Promise.all([
    import("./next-route-harness"),
    import("next/server"),
    import("@/app/api/agent/tasks/[taskId]/workflow/route"),
    import("@/lib/agents/workflow/token/task"),
  ]);

  return async (action, extra = {}) => {
    const req = new NextRequest(`http://127.0.0.1/api/agent/tasks/${args.taskId}/workflow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: args.messageId,
        token: token.createTaskWorkflowToken(args.messageId, args.taskId, args.agentSlug),
        action,
        ...extra,
      }),
    });
    const res = await runRouteHandler(() =>
      route.POST(req, { params: Promise.resolve({ taskId: args.taskId }) }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
}

/**
 * Produce a real workflow grant turn for `task`, the way PM does, and return a
 * poster bound to it.
 *
 * Going through `sendTaskWorkflowNotification` rather than inserting an
 * AgentChatMessage by hand is what makes the grant pass
 * `hasAuthorizedTaskAgentOrigin` — the origin check is part of the contract the
 * scenarios are protecting.
 */
export interface ScenarioReplyTarget {
  kind: "task-comment";
  agentSlug: string;
  taskId: string;
  messageId: string;
}

/**
 * The reply target PM uses for a comment-surface workflow turn.
 *
 * Scenarios need it to feed stream events (`done`, `error`) back through
 * `recordPmChannelRunEvent`, which is how a turn actually ends in production.
 */
export function replyTargetFor(args: {
  agentSlug: string;
  taskId: string;
  messageId: string;
}): ScenarioReplyTarget {
  return { kind: "task-comment", ...args };
}

export async function dispatchWorkflowTurn(args: {
  boot: Awaited<ReturnType<typeof bootScenarioDb>>;
  world: ScenarioWorld;
  taskId: string;
  reason?: string;
  body?: string;
}): Promise<{ messageId: string; post: WorkflowPoster; target: ScenarioReplyTarget }> {
  const turn = await args.boot.notifications.sendTaskWorkflowNotification({
    taskId: args.taskId,
    targetUserId: args.world.agentUserId,
    actor: { id: args.world.ownerId, kind: "human", username: "owner" },
    // The reason strings are a closed union in the notifications module; the
    // cast keeps the harness from having to restate that union and drift.
    reason: (args.reason ?? "monitor_recovery") as Parameters<
      typeof args.boot.notifications.sendTaskWorkflowNotification
    >[0]["reason"],
    body: args.body ?? "Continue the implementation.",
  });
  if (!turn) throw new Error(`dispatchWorkflowTurn: PM produced no turn for task ${args.taskId}`);
  const post = await makeWorkflowPoster({
    taskId: args.taskId,
    messageId: turn.messageId,
    agentSlug: args.world.agentSlug,
  });
  return {
    messageId: turn.messageId,
    post,
    target: replyTargetFor({
      agentSlug: args.world.agentSlug,
      taskId: args.taskId,
      messageId: turn.messageId,
    }),
  };
}

// ---------------------------------------------------------------------------
// Run-state readers
// ---------------------------------------------------------------------------

/**
 * The run/continuation state a scenario asserts on, in one read.
 *
 * Scenarios ask "what does the durable state say about this turn?" constantly;
 * spelling out the same two queries twelve times would bury the assertion that
 * actually differs between cases.
 */
export async function readRunState(
  db: ScenarioDb,
  args: { taskId: string; agentSlug?: string },
) {
  const runs = await db.pmChannelRun.findMany({
    where: { taskId: args.taskId, ...(args.agentSlug ? { agentSlug: args.agentSlug } : {}) },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      messageId: true,
      status: true,
      disposition: true,
      lastAction: true,
      settledByAction: true,
      completedAt: true,
      finishedReason: true,
      supersededByRunId: true,
      lastEventAt: true,
    },
  });
  const continuations = await db.pmChannelContinuation.findMany({
    where: { runId: { in: runs.map((run) => run.id) } },
    orderBy: { createdAt: "asc" },
    select: { id: true, runId: true, status: true, action: true, messageId: true },
  });
  return {
    runs,
    continuations,
    open: continuations.filter((c) => ["armed", "queued", "dispatching"].includes(c.status)),
    active: runs.filter((run) => ["queued", "accepted", "streaming"].includes(run.status)),
  };
}

/**
 * The durable board-visible progress on a task.
 *
 * `alertReporter` is PM's "a human must look at this" flag, and
 * `executionState` is the ENV-123 operator strip — between them they are what a
 * scenario means when it asks whether progress survived an interruption.
 */
export async function readTaskProgress(db: ScenarioDb, taskId: string) {
  const [task, checklist, doneChecklist, comments, episodes, executionState] = await Promise.all([
    db.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { status: true, alertReporter: true, approvedOn: true },
    }),
    db.subTask.count({ where: { taskId } }),
    db.subTask.count({ where: { taskId, completedAt: { not: null } } }),
    db.comment.count({ where: { taskId } }),
    db.taskExecutionEpisode.count({ where: { taskId } }),
    db.taskExecutionState.findUnique({
      where: { taskId },
      select: { state: true, reasonCode: true, recoveryAction: true, escalatedAt: true },
    }),
  ]);
  return { ...task, checklist, doneChecklist, comments, episodes, executionState };
}
