// ORCH-04..07 — Procedure handler registration barrel.
//
// Imported by instrumentation.node.ts (or the procedure runner) to register
// all step handlers at module load time. Each procedure implementation module
// exports a `register*Handlers` function that calls registerStepHandler for
// each of its steps. This barrel ensures they are all called exactly once.

import { registerPrepareTodoTaskHandlers } from "@/lib/tasks/orchestrator/handlers/prepare-todo-task";
import { registerStartImplementationCycleHandlers } from "@/lib/tasks/orchestrator/handlers/start-implementation-cycle";
import { registerSubmitCandidateForReviewHandlers } from "@/lib/tasks/orchestrator/handlers/submit-candidate-for-review";
import { registerReturnReviewForChangesHandlers, registerFinalizeAcceptedReviewHandlers } from "@/lib/tasks/orchestrator/handlers/review-decisions";

let registered = false;

export function registerAllProcedureHandlers(): void {
  if (registered) return;
  registered = true;
  registerPrepareTodoTaskHandlers();
  registerStartImplementationCycleHandlers();
  registerSubmitCandidateForReviewHandlers();
  registerReturnReviewForChangesHandlers();
  registerFinalizeAcceptedReviewHandlers();
}

// Auto-register on import so the procedure runner finds handlers without
// an explicit call site in instrumentation.
registerAllProcedureHandlers();