import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/agent/tasks/[taskId]/workflow/route.ts", "utf8");
assert.match(route, /submitAuthoritativeAgentWorkflowAction/);
assert.match(route, /ownership\.engine !== ENGINE_ORCHESTRATOR_V2/);
assert.match(route, /Legacy workflow mutation ownership is retired/);
assert.doesNotMatch(route, /dispatchByDurableEngine|computeV2Prediction|recordV2Comparison/);
assert.doesNotMatch(route, /applyTaskTransition|recordLegacyWorkflowBoundaryInvocation/);
assert.equal((route.match(/submitAuthoritativeAgentWorkflowAction\(/g) ?? []).length, 1);

console.log("[phasee-08-agent-route] single authoritative route boundary passed");
