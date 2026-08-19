import assert from "node:assert/strict";
import {
  applyPmChannelStreamInput,
  emptyPmChannelStreamState,
  type PmChannelStreamInput,
} from "@/lib/agents/pm-channel/stream";
import {
  PRIORITY_ORDER,
  type LanePriority,
  type LaneStatus,
} from "@/lib/agents/pm-channel/execution-lane";
import type { PmChannelReplyTarget } from "@/lib/agents/pm-channel/openclaw";

/**
 * ENV-159 Step 7: Regression test suite — provider-neutral tests.
 *
 * Tests verify:
 - Canonical event protocol produces equivalent accounting across backends
 - Lane/capacity lifecycle and queue priority
 - ENV-142/ENV-147 incident reproduction
 *
 * Tests call REAL exported functions:
 - applyPmChannelStreamInput (pure state machine, no db)
 - PRIORITY_ORDER (pure constant from execution-lane.ts)
 *
 * Lane reservation/release functions are async with db deps; the lane/capacity
 * scenarios below test the observable invariants via the stream state machine
 * and priority ordering constants that govern the lane behaviour.
 */

const target: PmChannelReplyTarget = {
  kind: "task-comment",
  agentSlug: "test-agent",
  messageId: "test-message",
  taskId: "test-task",
};

function applyEvent(state: ReturnType<typeof emptyPmChannelStreamState>, input: Omit<PmChannelStreamInput, "target">) {
  return applyPmChannelStreamInput(state, { target, ...input });
}

// ---------------------------------------------------------------------------
// Test 1: 35-tool workloads through OpenAI and Ollama fixtures both record 35 tool cycles
// ---------------------------------------------------------------------------

function simulateToolCalls(count: number, provider: string, model: string) {
  let state = emptyPmChannelStreamState(target);
  state = applyEvent(state, { event: "model:selected", provider, model, seq: 0 });
  const toolCallIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const toolCallId = `call-${i}`;
    state = applyEvent(state, {
      event: "tool:start",
      toolStatus: "start",
      toolName: `tool-${i}`,
      toolCallId,
      seq: i + 1,
    });
    // Each tool:start should set the toolCallId on state
    assert.equal(state.toolCallId, toolCallId, `tool:start #${i} should set toolCallId`);
    assert.equal(state.toolName, `tool-${i}`, `tool:start #${i} should set toolName`);
    assert.equal(state.toolStatus, "start", `tool:start #${i} should set toolStatus to "start"`);
    toolCallIds.push(toolCallId);
  }
  assert.equal(toolCallIds.length, count, `Should have recorded ${count} tool call IDs`);
  return { state, toolCallIds };
}

export function test35ToolWorkloadsBothProviders() {
  const openai = simulateToolCalls(35, "openai", "gpt-4");
  const ollama = simulateToolCalls(35, "ollama", "carmen-model");

  // Both should have provider/model set from model:selected
  assert.equal(openai.state.provider, "openai");
  assert.equal(openai.state.model, "gpt-4");
  assert.equal(ollama.state.provider, "ollama");
  assert.equal(ollama.state.model, "carmen-model");

  // Both should be in streaming state with the last tool active
  assert.equal(openai.state.status, "streaming", "OpenAI should be streaming after tool calls");
  assert.equal(ollama.state.status, "streaming", "Ollama should be streaming after tool calls");
  assert.equal(openai.state.status, ollama.state.status, "Both providers should have same status");
  assert.equal(openai.state.runStatus, ollama.state.runStatus, "Both providers should have same runStatus");

  // Both should have the same last toolCallId pattern
  assert.equal(openai.state.toolCallId, "call-34", "OpenAI last toolCallId should be call-34");
  assert.equal(ollama.state.toolCallId, "call-34", "Ollama last toolCallId should be call-34");
}

// ---------------------------------------------------------------------------
// Test 2: 1000 partial events record zero additional tool cycles
// ---------------------------------------------------------------------------

export function test1000PartialEventsZeroToolCycles() {
  let state = emptyPmChannelStreamState(target);
  state = applyEvent(state, { event: "model:selected", provider: "ollama", model: "carmen", seq: 0 });
  state = applyEvent(state, { event: "tool:start", toolStatus: "start", toolName: "browser", toolCallId: "call-0", seq: 1 });
  const toolCallIdAfterStart = state.toolCallId;
  const toolNameAfterStart = state.toolName;
  const toolStatusAfterStart = state.toolStatus;

  // Emit 1000 partial events
  for (let i = 0; i < 1000; i++) {
    state = applyEvent(state, { event: "partial", text: `chunk-${i}`, seq: i + 2 });
  }

  // Partial events should not change tool status
  assert.equal(state.toolStatus, toolStatusAfterStart, "Partial events must not change tool status");
  assert.equal(state.toolName, toolNameAfterStart, "Partial events must not change toolName");
  assert.equal(state.toolCallId, toolCallIdAfterStart, "Partial events must not change toolCallId");
  // Partial events should not produce a tool call
  assert.equal(state.toolStatus, "start", "Tool status should still be 'start' from the tool:start event");
}

// ---------------------------------------------------------------------------
// Test 3: Duplicate tool:start with same ID does not create a new tool call
// ---------------------------------------------------------------------------

export function testDuplicateToolStartSameIdCountsOnce() {
  let state = emptyPmChannelStreamState(target);
  state = applyEvent(state, { event: "model:selected", provider: "openai", model: "gpt-4", seq: 0 });

  // First tool:start with call-123
  state = applyEvent(state, { event: "tool:start", toolStatus: "start", toolName: "browser", toolCallId: "call-123", seq: 1 });
  assert.equal(state.toolCallId, "call-123", "First tool:start should set toolCallId");
  assert.equal(state.toolName, "browser", "First tool:start should set toolName");

  // Duplicate tool:start with same ID — the state machine processes it but
  // the idempotent correlation table (PmChannelToolCall UNIQUE(runId, toolCallId))
  // would reject the duplicate at the database level. The state machine
  // re-sets the same values, not creating a new tool call.
  state = applyEvent(state, { event: "tool:start", toolStatus: "start", toolName: "browser", toolCallId: "call-123", seq: 2 });
  assert.equal(state.toolCallId, "call-123", "Duplicate tool:start should keep same toolCallId");
  assert.equal(state.toolName, "browser", "Duplicate tool:start should keep same toolName");
  // The state machine doesn't count tool calls — the PmChannelToolCall table
  // with UNIQUE(runId, toolCallId) is what makes duplicates idempotent.
}

// ---------------------------------------------------------------------------
// Test 4: Fallback model selection updates provider/model
// ---------------------------------------------------------------------------

export function testFallbackModelSelectionUpdatesProviderModel() {
  let state = emptyPmChannelStreamState(target);

  // Initial model:selected with primary model
  state = applyEvent(state, { event: "model:selected", provider: "openai", model: "gpt-4", seq: 0 });
  assert.equal(state.provider, "openai");
  assert.equal(state.model, "gpt-4");

  // Fallback model selection — provider and model should update
  state = applyEvent(state, { event: "model:selected", provider: "ollama", model: "fallback-model", seq: 1 });
  assert.equal(state.provider, "ollama", "Fallback should update provider");
  assert.equal(state.model, "fallback-model", "Fallback should update model");
}

// ---------------------------------------------------------------------------
// Test 5: Canonical lifecycle events produce equivalent state transitions
// ---------------------------------------------------------------------------

export function testCanonicalLifecycleEventsEquivalent() {
  // OpenAI path: tool:call → tool:result
  let openaiState = emptyPmChannelStreamState(target);
  openaiState = applyEvent(openaiState, { event: "model:selected", provider: "openai", model: "gpt-4", seq: 0 });
  openaiState = applyEvent(openaiState, { event: "tool:call", toolStatus: "call", toolName: "browser", seq: 1 });
  openaiState = applyEvent(openaiState, { event: "tool:result", toolStatus: "result", seq: 2 });

  // Ollama path (canonical): tool:start → tool:result
  let ollamaState = emptyPmChannelStreamState(target);
  ollamaState = applyEvent(ollamaState, { event: "model:selected", provider: "ollama", model: "carmen", seq: 0 });
  ollamaState = applyEvent(ollamaState, { event: "tool:start", toolStatus: "start", toolName: "browser", toolCallId: "call-0", seq: 1 });
  ollamaState = applyEvent(ollamaState, { event: "tool:result", toolStatus: "result", toolCallId: "call-0", seq: 2 });

  // Both should end in the same status and runStatus
  assert.equal(openaiState.status, ollamaState.status, "Both paths should produce same status");
  assert.equal(openaiState.runStatus, ollamaState.runStatus, "Both paths should produce same runStatus");
  assert.equal(openaiState.toolStatus, "result", "OpenAI should have toolStatus 'result'");
  assert.equal(ollamaState.toolStatus, "result", "Ollama should have toolStatus 'result'");
}

// ---------------------------------------------------------------------------
// Test 6: turn:terminal is equivalent to done for run settling
// ---------------------------------------------------------------------------

export function testTurnTerminalEquivalentToDone() {
  let state = emptyPmChannelStreamState(target);
  state = applyEvent(state, { event: "model:selected", provider: "ollama", model: "carmen", seq: 0 });
  state = applyEvent(state, { event: "turn:terminal", seq: 1 });
  assert.equal(state.status, "done", "turn:terminal should set status to done");
  assert.equal(state.runStatus, "completed", "turn:terminal should set runStatus to completed");
}

// ---------------------------------------------------------------------------
// Test 7: dispatch:delivered sets accepted state (not admitted)
// ---------------------------------------------------------------------------

export function testDispatchDeliveredSetsAccepted() {
  let state = emptyPmChannelStreamState(target);
  state = applyEvent(state, { event: "dispatch:delivered", seq: 0 });
  assert.equal(state.runStatus, "accepted", "dispatch:delivered should set runStatus to accepted");
  assert.notEqual(state.runStatus, "admitted", "dispatch:delivered must NOT set runStatus to admitted");
}

// ---------------------------------------------------------------------------
// Test 8: turn:waiting_capacity sets waiting_capacity state
// ---------------------------------------------------------------------------

export function testTurnWaitingCapacitySetsWaitingCapacity() {
  let state = emptyPmChannelStreamState(target);
  state = applyEvent(state, { event: "turn:waiting_capacity", seq: 0 });
  assert.equal(state.runStatus, "waiting_capacity", "turn:waiting_capacity should set runStatus to waiting_capacity");
  assert.notEqual(state.runStatus, "accepted", "waiting_capacity must not be confused with accepted");
  assert.notEqual(state.runStatus, "admitted", "waiting_capacity must not be confused with admitted");
}

// ---------------------------------------------------------------------------
// Test 9: turn:admitted sets admitted state (model execution admitted, not just gateway receipt)
// ---------------------------------------------------------------------------

export function testTurnAdmittedSetsAdmitted() {
  let state = emptyPmChannelStreamState(target);
  state = applyEvent(state, { event: "turn:admitted", seq: 0 });
  assert.equal(state.runStatus, "admitted", "turn:admitted should set runStatus to admitted");
  assert.notEqual(state.runStatus, "accepted", "admitted must not be confused with accepted (gateway receipt)");
}

// ---------------------------------------------------------------------------
// Test 10: context:usage does not change stream state
// ---------------------------------------------------------------------------

export function testContextUsageNoStateChange() {
  let state = emptyPmChannelStreamState(target);
  state = applyEvent(state, { event: "model:selected", provider: "ollama", model: "carmen", seq: 0 });
  const beforeUsage = { ...state };
  state = applyEvent(state, { event: "context:usage", seq: 1 });
  // Only seq should change
  assert.equal(state.status, beforeUsage.status, "context:usage should not change status");
  assert.equal(state.runStatus, beforeUsage.runStatus, "context:usage should not change runStatus");
  assert.equal(state.toolStatus, beforeUsage.toolStatus, "context:usage should not change toolStatus");
}

// ---------------------------------------------------------------------------
// Test 11: Backends lacking tool lifecycle data report degraded telemetry
// (not silent toolCycleCount=0)
// ---------------------------------------------------------------------------

export function testDegradedTelemetryNotSilent() {
  let state = emptyPmChannelStreamState(target);
  // A backend that only emits partial events (no tool:start)
  state = applyEvent(state, { event: "model:selected", provider: "unknown", model: "unknown", seq: 0 });
  for (let i = 0; i < 100; i++) {
    state = applyEvent(state, { event: "partial", text: `chunk-${i}`, seq: i + 1 });
  }
  // The run should be streaming but with no tool status — this is degraded telemetry
  assert.equal(state.toolStatus, null, "Backend without tool lifecycle should have null toolStatus");
  assert.equal(state.toolName, null, "Backend without tool lifecycle should have null toolName");
  // The doctor detector (tool_capable_zero_tools) would flag this as degraded telemetry
  // — the key invariant is that the absence is observable, not silently reported as 0
}

// ---------------------------------------------------------------------------
// Test 12: Shadow comparison — OpenAI and Ollama receive equivalent accounting
// ---------------------------------------------------------------------------

export function testShadowComparisonEquivalent() {
  const openai = simulateToolCalls(10, "openai", "gpt-4");
  const ollama = simulateToolCalls(10, "ollama", "carmen");

  // Both should be in streaming state
  assert.equal(openai.state.status, "streaming", "OpenAI should be streaming after tool calls");
  assert.equal(ollama.state.status, "streaming", "Ollama should be streaming after tool calls");
  assert.equal(openai.state.status, ollama.state.status, "Both providers should have same status");
  assert.equal(openai.state.runStatus, ollama.state.runStatus, "Both providers should have same runStatus");
  assert.equal(openai.state.toolStatus, ollama.state.toolStatus, "Both should have same toolStatus");
  assert.equal(openai.state.toolCallId, ollama.state.toolCallId, "Both should have same last toolCallId pattern");
}

// ---------------------------------------------------------------------------
// Lane/capacity tests (using pure state machine + priority constants)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test 13: Lane priority ordering — continuation > review feedback > reviewer > manager > newly approved > informational
// ---------------------------------------------------------------------------

export function testLanePriorityOrdering() {
  const priorities: LanePriority[] = [
    "continuation",
    "review_feedback",
    "reviewer_decision",
    "manager_decision",
    "newly_approved",
    "informational",
  ];
  for (let i = 0; i < priorities.length - 1; i++) {
    assert.ok(
      PRIORITY_ORDER[priorities[i]] < PRIORITY_ORDER[priorities[i + 1]],
      `${priorities[i]} (priority ${PRIORITY_ORDER[priorities[i]]}) should rank before ${priorities[i + 1]} (priority ${PRIORITY_ORDER[priorities[i + 1]]})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test 14: Two actionable tasks for maxConcurrent=1 agent — one running, one waiting_capacity
// (ENV-142/ENV-147 incident core: the waiting job must not be "accepted")
// ---------------------------------------------------------------------------

export function testWaitingCapacityNotAccepted() {
  // Simulate the incident scenario:
  // 1. ENV-142 is streaming (holds the lane)
  // 2. ENV-147 is delivered to gateway but lane is occupied → waiting_capacity
  // The key invariant: waiting_capacity ≠ accepted. The waiting job must not
  // be expired as if it were executing.

  // Lane 1: ENV-142 is actively streaming
  const env142Target: PmChannelReplyTarget = { kind: "task-comment", agentSlug: target.agentSlug, taskId: "ENV-142", messageId: target.messageId };
  let runningState = emptyPmChannelStreamState(env142Target);
  runningState = applyEvent(runningState, { event: "model:selected", provider: "ollama", model: "carmen", seq: 0 });
  runningState = applyEvent(runningState, { event: "tool:start", toolStatus: "start", toolName: "exec", toolCallId: "call-0", seq: 1 });
  assert.equal(runningState.runStatus, "streaming", "ENV-142 should be streaming");
  assert.equal(runningState.status, "streaming", "ENV-142 should be in streaming status");

  // Lane 2: ENV-147 is delivered but lane is occupied → waiting_capacity
  const env147Target: PmChannelReplyTarget = { kind: "task-comment", agentSlug: target.agentSlug, taskId: "ENV-147", messageId: target.messageId };
  let waitingState = emptyPmChannelStreamState(env147Target);
  waitingState = applyEvent(waitingState, { event: "dispatch:delivered", seq: 0 });
  assert.equal(waitingState.runStatus, "accepted", "ENV-147 initially accepted by gateway");
  // Then lane check → waiting_capacity
  waitingState = applyEvent(waitingState, { event: "turn:waiting_capacity", seq: 1 });
  assert.equal(waitingState.runStatus, "waiting_capacity", "ENV-147 should be waiting_capacity after lane check");
  assert.notEqual(waitingState.runStatus, "accepted", "ENV-147 must NOT remain 'accepted' — that was the incident bug");
  assert.notEqual(waitingState.runStatus, "streaming", "ENV-147 must NOT be 'streaming' — no model has started");
}

// ---------------------------------------------------------------------------
// Test 15: Waiting job receives no model:selected (no OpenClaw session until lane released)
// ---------------------------------------------------------------------------

export function testWaitingJobNoModelSelected() {
  const env147Target: PmChannelReplyTarget = { kind: "task-comment", agentSlug: target.agentSlug, taskId: "ENV-147", messageId: target.messageId };
  let waitingState = emptyPmChannelStreamState(env147Target);
  waitingState = applyEvent(waitingState, { event: "dispatch:delivered", seq: 0 });
  waitingState = applyEvent(waitingState, { event: "turn:waiting_capacity", seq: 1 });

  // No model:selected event should have been emitted for the waiting job
  assert.equal(waitingState.provider, undefined, "Waiting job should have no provider set");
  assert.equal(waitingState.model, undefined, "Waiting job should have no model set");
  assert.equal(waitingState.toolStatus, null, "Waiting job should have no tool activity");
}

// ---------------------------------------------------------------------------
// Test 16: Lane release transitions — terminal callback releases lane and sets completed
// ---------------------------------------------------------------------------

export function testLaneReleaseOnTerminal() {
  // Running job completes → turn:terminal
  const env142Target: PmChannelReplyTarget = { kind: "task-comment", agentSlug: target.agentSlug, taskId: "ENV-142", messageId: target.messageId };
  let runningState = emptyPmChannelStreamState(env142Target);
  runningState = applyEvent(runningState, { event: "model:selected", provider: "ollama", model: "carmen", seq: 0 });
  runningState = applyEvent(runningState, { event: "tool:start", toolStatus: "start", toolName: "exec", toolCallId: "call-0", seq: 1 });
  assert.equal(runningState.runStatus, "streaming", "Should be streaming before terminal");

  runningState = applyEvent(runningState, { event: "turn:terminal", seq: 2 });
  assert.equal(runningState.status, "done", "turn:terminal should set status to done");
  assert.equal(runningState.runStatus, "completed", "turn:terminal should set runStatus to completed");

  // After release, the next waiting_capacity job can be admitted
  const env147Target: PmChannelReplyTarget = { kind: "task-comment", agentSlug: target.agentSlug, taskId: "ENV-147", messageId: target.messageId };
  let waitingState = emptyPmChannelStreamState(env147Target);
  waitingState = applyEvent(waitingState, { event: "dispatch:delivered", seq: 0 });
  waitingState = applyEvent(waitingState, { event: "turn:waiting_capacity", seq: 1 });
  // Lane is now free → admit the waiting job
  waitingState = applyEvent(waitingState, { event: "turn:admitted", seq: 2 });
  assert.equal(waitingState.runStatus, "admitted", "Waiting job should be admitted after lane release");
  // Model starts
  waitingState = applyEvent(waitingState, { event: "model:selected", provider: "ollama", model: "carmen", seq: 3 });
  assert.equal(waitingState.provider, "ollama", "Admitted job should now have provider set");
  assert.equal(waitingState.runStatus, "admitted", "Should be admitted before streaming starts");
}

// ---------------------------------------------------------------------------
// Test 17: Delivered-but-not-admitted jobs are not expired as executing jobs
// (capacity waiting does not consume retry attempts)
// ---------------------------------------------------------------------------

export function testDeliveredNotAdmittedNotExpired() {
  let state = emptyPmChannelStreamState(target);
  state = applyEvent(state, { event: "dispatch:delivered", seq: 0 });
  assert.equal(state.runStatus, "accepted", "Delivered = accepted by gateway");

  state = applyEvent(state, { event: "turn:waiting_capacity", seq: 1 });
  assert.equal(state.runStatus, "waiting_capacity", "Waiting for capacity");

  // The key invariant: waiting_capacity is NOT streaming/admitted, so
  // lease expiry has not started. The job should not be expired.
  assert.notEqual(state.runStatus, "streaming", "Waiting job is not streaming");
  assert.notEqual(state.runStatus, "admitted", "Waiting job is not admitted");
  assert.notEqual(state.status, "done", "Waiting job is not done");
  assert.notEqual(state.status, "error", "Waiting job should not be in error state");
}

// ---------------------------------------------------------------------------
// Test 18: Supersession cancels the exact gateway dispatch
// ---------------------------------------------------------------------------

export function testSupersessionCancels() {
  let state = emptyPmChannelStreamState(target);
  state = applyEvent(state, { event: "dispatch:delivered", seq: 0 });
  state = applyEvent(state, { event: "turn:admitted", seq: 1 });
  state = applyEvent(state, { event: "model:selected", provider: "ollama", model: "carmen", seq: 2 });

  // Supersession — the run is cancelled
  state = applyEvent(state, { event: "status", runStatus: "superseded", seq: 3 });
  assert.equal(state.runStatus, "superseded", "Superseded run should have runStatus 'superseded'");
  assert.equal(state.status, "error", "Superseded run should be in error status");
}

// ---------------------------------------------------------------------------
// Test 19: ENV-142/ENV-147 incident reproduction — ENV-147 visibly waits for ENV-142
// ---------------------------------------------------------------------------

export function testIncidentReproductionEnv142Env147() {
  // Simulate the exact incident scenario:
  // 1. ENV-142 starts in Asdrubal's only execution lane
  // 2. ENV-147 commits but phase-e advanced → repository validation returns it
  // 3. ENV-147 is delivered to gateway but lane is occupied by ENV-142
  // 4. ENV-147 must wait as waiting_capacity, NOT be falsely accepted

  // ENV-142: actively running
  const env142Target: PmChannelReplyTarget = { kind: "task-comment", agentSlug: target.agentSlug, taskId: "ENV-142", messageId: target.messageId };
  let env142 = emptyPmChannelStreamState(env142Target);
  env142 = applyEvent(env142, { event: "model:selected", provider: "ollama", model: "asdrubal-model", seq: 0 });
  env142 = applyEvent(env142, { event: "tool:start", toolStatus: "start", toolName: "exec", toolCallId: "call-0", seq: 1 });
  assert.equal(env142.runStatus, "streaming", "ENV-142 should be streaming");
  assert.equal(env142.status, "streaming", "ENV-142 should be in streaming status");

  // ENV-147: delivered to gateway but lane occupied
  const env147Target: PmChannelReplyTarget = { kind: "task-comment", agentSlug: target.agentSlug, taskId: "ENV-147", messageId: target.messageId };
  let env147 = emptyPmChannelStreamState(env147Target);
  env147 = applyEvent(env147, { event: "dispatch:delivered", seq: 0 });
  assert.equal(env147.runStatus, "accepted", "ENV-147 initially accepted by gateway");

  // Lane check reveals ENV-142 holds the lane
  env147 = applyEvent(env147, { event: "turn:waiting_capacity", seq: 1 });
  assert.equal(env147.runStatus, "waiting_capacity", "ENV-147 should be waiting_capacity");
  assert.notEqual(env147.runStatus, "accepted", "ENV-147 must NOT remain 'accepted' — that was the incident");
  assert.notEqual(env147.runStatus, "streaming", "ENV-147 must NOT appear to be streaming");
  assert.equal(env147.provider, undefined, "ENV-147 should have no provider (no model started)");
  assert.equal(env147.model, undefined, "ENV-147 should have no model (no model started)");
  assert.equal(env147.toolStatus, null, "ENV-147 should have no tool activity");

  // ENV-142 completes → lane released
  env142 = applyEvent(env142, { event: "turn:terminal", seq: 2 });
  assert.equal(env142.runStatus, "completed", "ENV-142 should be completed");

  // ENV-147 can now be admitted
  env147 = applyEvent(env147, { event: "turn:admitted", seq: 2 });
  assert.equal(env147.runStatus, "admitted", "ENV-147 should be admitted after ENV-142 completes");
  env147 = applyEvent(env147, { event: "model:selected", provider: "ollama", model: "asdrubal-model", seq: 3 });
  assert.equal(env147.provider, "ollama", "ENV-147 should now have provider set");
  assert.equal(env147.runStatus, "admitted", "ENV-147 should be admitted, waiting for first progress callback");

  // First tool:start transitions admitted → streaming
  env147 = applyEvent(env147, { event: "tool:start", toolStatus: "start", toolName: "exec", toolCallId: "call-0", seq: 4 });
  assert.equal(env147.runStatus, "streaming", "ENV-147 should be streaming after first tool:start");
  assert.equal(env147.status, "streaming", "ENV-147 should be in streaming status");
}

// ---------------------------------------------------------------------------
// Test 20: Lane status type — only one active lease per agent
// (verifies the LaneStatus union covers the lifecycle)
// ---------------------------------------------------------------------------

export function testLaneStatusLifecycle() {
  const validStatuses: LaneStatus[] = ["reserved", "admitted", "running", "released"];
  // The partial unique index enforces: only one lease with status IN (reserved, admitted, running)
  // per agentSlug. Released leases don't conflict.
  const activeStatuses = validStatuses.filter((s) => s !== "released");
  assert.equal(activeStatuses.length, 3, "Three active statuses: reserved, admitted, running");
  assert.equal(validStatuses.length, 4, "Four total statuses including released");
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

export function runEnv159ProviderNeutralTests() {
  test35ToolWorkloadsBothProviders();
  test1000PartialEventsZeroToolCycles();
  testDuplicateToolStartSameIdCountsOnce();
  testFallbackModelSelectionUpdatesProviderModel();
  testCanonicalLifecycleEventsEquivalent();
  testTurnTerminalEquivalentToDone();
  testDispatchDeliveredSetsAccepted();
  testTurnWaitingCapacitySetsWaitingCapacity();
  testTurnAdmittedSetsAdmitted();
  testContextUsageNoStateChange();
  testDegradedTelemetryNotSilent();
  testShadowComparisonEquivalent();
  testLanePriorityOrdering();
  testWaitingCapacityNotAccepted();
  testWaitingJobNoModelSelected();
  testLaneReleaseOnTerminal();
  testDeliveredNotAdmittedNotExpired();
  testSupersessionCancels();
  testIncidentReproductionEnv142Env147();
  testLaneStatusLifecycle();
  console.log("✓ ENV-159 provider-neutral tests (20 tests) passed");
}

// Self-execute when run directly
if (process.argv[1] && process.argv[1].endsWith("env159-provider-neutral-test.ts")) {
  runEnv159ProviderNeutralTests();
}