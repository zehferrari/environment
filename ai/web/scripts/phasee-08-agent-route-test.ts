import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AGENT_WORKFLOW_PUBLIC_ACTIONS,
  decorateAuthoritativeAgentResponseCache,
  dispatchByDurableEngine,
  mapOrchestratorResultToAgentHttp,
} from "@/lib/tasks/orchestrator/agent-route-adapter";
import { PUBLIC_ACTION_TO_INTENT } from "@/lib/tasks/orchestrator/normalize";
import {
  ENGINE_LEGACY,
  ENGINE_ORCHESTRATOR_V2,
} from "@/lib/tasks/orchestrator/ownership";
import { WORKFLOW_PUBLIC_ACTIONS, type OrchestratorResult } from "@/lib/tasks/orchestrator/types";

async function verifyNoFallbackMatrix() {
  const outcomes: Array<{ name: string; result: OrchestratorResult }> = [
    { name: "accepted", result: { status: "accepted", transitionId: "t1", workflowVersion: 2 } },
    { name: "replayed", result: { status: "replayed", transitionId: "t1", workflowVersion: 2 } },
    { name: "authorization", result: { status: "forbidden", reason: "denied", domainCode: "not_authorized" } },
    { name: "guard", result: { status: "invalid", reason: "guard", domainCode: "checklist_incomplete" } },
    { name: "stale-state", result: { status: "stale", reason: "stale", domainCode: "stale_version" } },
    { name: "operational", result: { status: "operational", reason: "down", domainCode: "operational_error" } },
  ];
  for (const outcome of outcomes) {
    let authoritativeAttempts = 0;
    let legacyMutationAttempts = 0;
    const result = await dispatchByDurableEngine({
      engine: ENGINE_ORCHESTRATOR_V2,
      runAuthoritative: async () => {
        authoritativeAttempts += 1;
        return outcome.result;
      },
      runLegacy: async () => {
        legacyMutationAttempts += 1;
        throw new Error("legacy mutation must be unreachable");
      },
    });
    assert.equal(result.status, outcome.result.status, `${outcome.name}: authoritative result is returned`);
    assert.equal(authoritativeAttempts, 1, `${outcome.name}: one V2 submission`);
    assert.equal(legacyMutationAttempts, 0, `${outcome.name}: zero legacy mutation attempts`);
  }

  let legacyAttempts = 0;
  let authoritativeAttempts = 0;
  const legacyResult = await dispatchByDurableEngine({
    engine: ENGINE_LEGACY,
    runAuthoritative: async () => {
      authoritativeAttempts += 1;
      return "v2";
    },
    runLegacy: async () => {
      legacyAttempts += 1;
      return "legacy";
    },
  });
  assert.equal(legacyResult, "legacy");
  assert.equal(legacyAttempts, 1);
  assert.equal(authoritativeAttempts, 0);

  let rejectedLegacyAttempts = 0;
  await assert.rejects(() => dispatchByDurableEngine({
    engine: ENGINE_ORCHESTRATOR_V2,
    runAuthoritative: async () => { throw new Error("orchestrator transport failure"); },
    runLegacy: async () => {
      rejectedLegacyAttempts += 1;
      return "legacy";
    },
  }), /orchestrator transport failure/);
  assert.equal(rejectedLegacyAttempts, 0, "a thrown V2 operational failure also cannot fall back");
}

function verifyResultMapping() {
  const cases: Array<{ result: OrchestratorResult; expected: number }> = [
    { result: { status: "accepted", transitionId: "t", workflowVersion: 1 }, expected: 202 },
    { result: { status: "replayed", transitionId: "t", workflowVersion: 1 }, expected: 200 },
    { result: { status: "forbidden", reason: "no", domainCode: "not_authorized" }, expected: 403 },
    { result: { status: "stale", reason: "old", domainCode: "stale_version" }, expected: 409 },
    { result: { status: "invalid", reason: "bad", domainCode: "invalid_payload" }, expected: 422 },
    { result: { status: "operational", reason: "down", domainCode: "operational_error" }, expected: 503 },
  ];
  for (const entry of cases) {
    const mapped = mapOrchestratorResultToAgentHttp({
      taskId: "task-1",
      action: "checkpoint",
      taskStatus: "In Progress",
      result: entry.result,
    });
    assert.equal(mapped.status, entry.expected, `maps ${entry.result.status}`);
  }
}

function verifyVocabularyAndCacheDecorator() {
  assert.deepEqual(
    AGENT_WORKFLOW_PUBLIC_ACTIONS,
    WORKFLOW_PUBLIC_ACTIONS.filter((action) => action !== "override_status"),
    "agent vocabulary is derived from the one canonical public-action list",
  );
  assert.equal(AGENT_WORKFLOW_PUBLIC_ACTIONS.length, 20);
  for (const action of AGENT_WORKFLOW_PUBLIC_ACTIONS) {
    assert.ok(PUBLIC_ACTION_TO_INTENT.has(action), `${action} has one canonical intent registration`);
  }

  const calls: string[] = [];
  decorateAuthoritativeAgentResponseCache(
    { taskId: "task-1", projectSlug: "project-1" },
    {
      revalidateTaskReplyScope: (_taskId, scope) => { calls.push(`reply:${scope}`); },
      revalidateTaskShell: () => { calls.push("shell"); },
      revalidatePath: (value) => { calls.push(`path:${value}`); },
    },
  );
  assert.deepEqual(calls, [
    "reply:comment",
    "reply:chat",
    "shell",
    "path:/projects/project-1/tasks/task-1",
    "path:/projects/project-1",
  ]);

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    assert.doesNotThrow(() => decorateAuthoritativeAgentResponseCache(
      { taskId: "task-1", projectSlug: "project-1" },
      {
        revalidateTaskReplyScope: () => { throw new Error("cache unavailable"); },
        revalidateTaskShell: () => undefined,
        revalidatePath: () => undefined,
      },
    ), "cache failure is fail-soft after authoritative commit");
  } finally {
    console.error = originalConsoleError;
  }

  const source = readFileSync(path.join(process.cwd(), "lib/tasks/orchestrator/agent-route-adapter.ts"), "utf8");
  const decorator = source.slice(
    source.indexOf("export function decorateAuthoritativeAgentResponseCache"),
    source.indexOf("function actorRole"),
  );
  assert.doesNotMatch(decorator, /\bdb\.|recordWorkflowActionExecutionState|publishBoardTouch|submitWorkflowCommand/);
}

function verifyRouteFence() {
  const source = readFileSync(
    path.join(process.cwd(), "app/api/agent/tasks/[taskId]/workflow/route.ts"),
    "utf8",
  );
  const resolveIndex = source.indexOf("const ownership = await resolveEngineOwnership");
  const legacyIndex = source.indexOf("await recordLegacyWorkflowBoundaryInvocation", resolveIndex);
  assert.ok(resolveIndex > 0 && legacyIndex > resolveIndex, "durable ownership is resolved before the legacy boundary counter");
  assert.ok(source.includes("dispatchByDurableEngine"));
  assert.ok(source.includes("submitAuthoritativeAgentWorkflowAction"));
  assert.ok(source.includes("if (captured.authoritativeV2) return response"));
  assert.ok(source.includes("computeV2Prediction"), "legacy comparison code remains for drain-owned attempts");
}

async function main() {
  await verifyNoFallbackMatrix();
  verifyResultMapping();
  verifyVocabularyAndCacheDecorator();
  verifyRouteFence();
  console.log("[phasee-08-agent-route] PASS");
}

main().catch((error) => {
  console.error("[phasee-08-agent-route] FAIL", error);
  process.exit(1);
});
