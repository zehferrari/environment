import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const shared = read("lib/tasks/orchestrator/intents/shared.ts");
const publicBoundary = read("lib/tasks/orchestrator/index.ts");
const execute = read("lib/tasks/orchestrator/execute.ts");
const proposal = read("lib/work-items/apply.ts");
const epic = read("lib/epics/actions.ts");

assert.match(
  shared,
  /new IntentReceiptResolution\(receipt\.kind, receipt\.result\)/,
  "receipt rollback signals must retain replay/race classification",
);
assert.match(
  publicBoundary,
  /getIntentReceiptResolution as getWorkflowTransactionResolution/,
  "batch owners need a public typed receipt-race classifier",
);
assert.match(
  execute,
  /catch \(error\)[\s\S]*error instanceof IntentReceiptResolution[\s\S]*return error\.result/,
  "the ordinary command transaction must translate the rollback signal",
);

for (const [name, source] of [["proposal", proposal], ["Epic bulk", epic]] as const) {
  const transaction = source.indexOf("await db.$transaction");
  const catchBoundary = source.indexOf("} catch (error)", transaction);
  const classifier = source.indexOf("getWorkflowTransactionResolution(error)", catchBoundary);
  assert(transaction >= 0 && catchBoundary > transaction && classifier > catchBoundary,
    `${name} must classify receipt races only after its whole transaction rolls back`);
}

assert.match(
  proposal,
  /workflow_receipt_race_unsettled:[^\n]+retry the proposal/,
  "proposal races must return a typed retry result instead of leaking the control-flow sentinel",
);
assert.match(
  epic,
  /const winnerApplied = winnerTasks\.length === uniqueIds\.length/,
  "Epic batch replay must verify the winner applied the complete aggregate",
);

console.log("Phase E transaction receipt boundary tests passed");
