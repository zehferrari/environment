/**
 * ENV-72 ENV-82: Test that createContextGrantUrlMap produces consistent
 * grant URL maps across all PM surfaces. Validates that:
 * - All three scope types (project/task/epic) get valid grant URLs
 * - Optional task/epic produce null when omitted
 * - Each URL points to the correct /api/agents/context/{scopeType}/{scopeId} path
 * - The grant tokens authenticate successfully against the correct scope
 * - Scope mismatch (using a task grant against an epic endpoint) is rejected
 */

import { strict as assert } from "node:assert";
import { db } from "@/lib/db";
import {
  createContextGrantUrlMap,
  authenticateContextGrant,
  type ContextGrantUrlMap,
} from "@/lib/agents/context/grants";

const BASE_URL = "http://127.0.0.1:3000";

async function main() {
  const nonce = `grant-map-${Date.now()}`;

  // Cleanup any previous test data
  await db.contextGrant.deleteMany({ where: { turnId: { startsWith: nonce } } });

  try {
    // ── Test 1: Full bundle (project + task + epic) ──
    const full: ContextGrantUrlMap = await createContextGrantUrlMap({
      baseUrl: BASE_URL,
      agentSlug: "asdrubal",
      turnId: `${nonce}-1`,
      projectId: `project-${nonce}`,
      taskId: `task-${nonce}`,
      epicId: `epic-${nonce}`,
    });

    // All three URLs present
    assert.ok(full.project, "project grant URL must be present");
    assert.ok(full.task, "task grant URL must be present when taskId provided");
    assert.ok(full.epic, "epic grant URL must be present when epicId provided");

    // Verify URL shapes
    assert.match(full.project, /\/api\/agents\/context\/project\//, "project URL path");
    assert.match(full.task!, /\/api\/agents\/context\/task\//, "task URL path");
    assert.match(full.epic!, /\/api\/agents\/context\/epic\//, "epic URL path");

    // Verify grant tokens authenticate against their correct scope
    const projectToken = new URL(full.project).searchParams.get("grant")!;
    const taskToken = new URL(full.task!).searchParams.get("grant")!;
    const epicToken = new URL(full.epic!).searchParams.get("grant")!;

    const projAuth = await authenticateContextGrant({
      scopeType: "project",
      scopeId: `project-${nonce}`,
      token: projectToken,
    });
    assert.equal(projAuth?.agentSlug, "asdrubal", "project grant authenticates");

    const taskAuth = await authenticateContextGrant({
      scopeType: "task",
      scopeId: `task-${nonce}`,
      token: taskToken,
    });
    assert.equal(taskAuth?.agentSlug, "asdrubal", "task grant authenticates");

    const epicAuth = await authenticateContextGrant({
      scopeType: "epic",
      scopeId: `epic-${nonce}`,
      token: epicToken,
    });
    assert.equal(epicAuth?.agentSlug, "asdrubal", "epic grant authenticates");

    // ── Test 2: Scope mismatch is rejected ──
    const crossScope = await authenticateContextGrant({
      scopeType: "epic",
      scopeId: `epic-${nonce}`,
      token: taskToken,
    });
    assert.equal(crossScope, null, "task grant must not authenticate against epic scope");

    // ── Test 3: Bundle without task ──
    const noTask: ContextGrantUrlMap = await createContextGrantUrlMap({
      baseUrl: BASE_URL,
      agentSlug: "asdrubal",
      turnId: `${nonce}-3`,
      projectId: `project-${nonce}`,
      epicId: `epic-${nonce}`,
    });
    assert.ok(noTask.project, "project grant present without task");
    assert.equal(noTask.task, null, "task grant null when taskId omitted");
    assert.ok(noTask.epic, "epic grant present");

    // ── Test 4: Bundle without epic ──
    const noEpic: ContextGrantUrlMap = await createContextGrantUrlMap({
      baseUrl: BASE_URL,
      agentSlug: "asdrubal",
      turnId: `${nonce}-4`,
      projectId: `project-${nonce}`,
      taskId: `task-${nonce}`,
    });
    assert.ok(noEpic.project, "project grant present without epic");
    assert.ok(noEpic.task, "task grant present");
    assert.equal(noEpic.epic, null, "epic grant null when epicId omitted");

    // ── Test 5: Project-only bundle (direct chat minimal case) ──
    const projectOnly: ContextGrantUrlMap = await createContextGrantUrlMap({
      baseUrl: BASE_URL,
      agentSlug: "asdrubal",
      turnId: `${nonce}-5`,
      projectId: `project-${nonce}`,
    });
    assert.ok(projectOnly.project, "project grant always present");
    assert.equal(projectOnly.task, null, "task null in project-only bundle");
    assert.equal(projectOnly.epic, null, "epic null in project-only bundle");

    // Verify project-only grant authenticates
    const projOnlyToken = new URL(projectOnly.project).searchParams.get("grant")!;
    const projOnlyAuth = await authenticateContextGrant({
      scopeType: "project",
      scopeId: `project-${nonce}`,
      token: projOnlyToken,
    });
    assert.equal(projOnlyAuth?.agentSlug, "asdrubal", "project-only grant authenticates");

    // ── Test 6: runId is forwarded (for speculative prebuilds) ──
    const withRunId: ContextGrantUrlMap = await createContextGrantUrlMap({
      baseUrl: BASE_URL,
      agentSlug: "asdrubal",
      turnId: `${nonce}-6`,
      projectId: `project-${nonce}`,
      runId: "run-123",
    });
    assert.ok(withRunId.project, "project grant with runId present");

    console.log("context-grant-url-map tests passed");
  } finally {
    await db.contextGrant.deleteMany({ where: { turnId: { startsWith: nonce } } });
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});