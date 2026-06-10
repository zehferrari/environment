import assert from "node:assert/strict";
import {
  applyPmChannelStreamInput,
  emptyPmChannelStreamState,
  type PmChannelStreamInput,
} from "@/lib/agents/pm-channel-stream";

const target = {
  kind: "direct" as const,
  agentSlug: "proto-agent",
  messageId: "proto-message",
};

let state = emptyPmChannelStreamState(target);

function apply(input: Omit<PmChannelStreamInput, "target">) {
  state = applyPmChannelStreamInput(state, { target, ...input });
  return state;
}

assert.equal(state.lifecycleStatus, null, "fresh streams have no guessed lifecycle status");

apply({ event: "status:thinking" });
assert.equal(state.lifecycleStatus, "thinking", "status:thinking sets an explicit thinking lifecycle status");
assert.equal(state.status, "streaming");

apply({ event: "status:reading" });
assert.equal(state.lifecycleStatus, "reading", "status:reading replaces the lifecycle status");

apply({ event: "tool:call", toolName: "memory_search" });
assert.equal(state.lifecycleStatus, "working", "tool calls are active work");
assert.equal(state.toolStatus, "call");
assert.equal(state.toolName, "memory_search");

apply({ event: "tool:result", toolName: "memory_search" });
assert.equal(state.toolStatus, "result");
assert.equal(state.toolName, "memory_search");

apply({ event: "token", delta: "hello" });
assert.equal(state.text, "hello", "token events append text like legacy partial events");
assert.equal(state.runStatus, "streaming");

apply({ event: "final", text: "hello world", replace: true });
assert.equal(state.text, "hello world");
assert.equal(state.status, "done");
assert.equal(state.runStatus, "complete");
assert.equal(state.error, null);

state = emptyPmChannelStreamState(target);
apply({ event: "status", statusKind: "working", runStatus: "accepted" });
assert.equal(state.lifecycleStatus, "working", "legacy status events can carry typed lifecycle status");
assert.equal(state.runStatus, "accepted");

console.log("pm channel stream typed protocol tests passed");
