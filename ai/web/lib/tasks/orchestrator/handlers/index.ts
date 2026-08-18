// ORCH-04..07 — Procedure handler registration barrel.
//
// Imported by instrumentation.node.ts (or the procedure runner) to register
// all step handlers at module load time. Each procedure implementation module
// exports a `register*Handlers` function that calls registerStepHandler for
// each of its steps. This barrel ensures they are all called exactly once.

import { registerPrepareTodoTaskHandlers } from "@/lib/tasks/orchestrator/handlers/prepare-todo-task";

let registered = false;

export function registerAllProcedureHandlers(): void {
  if (registered) return;
  registered = true;
  registerPrepareTodoTaskHandlers();
  // ORCH-05..07 will add their registrations here.
}

// Auto-register on import so the procedure runner finds handlers without
// an explicit call site in instrumentation.
registerAllProcedureHandlers();