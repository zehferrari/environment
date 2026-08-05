// ENV-123 — keeping the execution strip current on ORDINARY workflow actions.
//
// The watchdog pass runs on the worker drain, so without this the strip would
// lag every real transition by up to a drain interval. An operator who watches
// an agent call `ready_for_review` and then sees "Execution: running / Reason:
// an execution turn is running" for the next minute has learned to distrust the
// strip, and a distrusted strip sends them straight back to reading comments —
// which is the exact failure this task exists to remove.
//
// This is deliberately a NARROW writer. It records what PM just durably
// observed: the action, when, and the state that action implies. It never
// touches the circuit-breaker columns and never invents a recovery: only
// `repairs.ts` may say the watchdog did something. When a previous watchdog
// recovery is on the row and the agent has now moved on under its own steam,
// the recovery is cleared — it describes a past intervention, not the present.

import { db } from "@/lib/db";
import {
  isContinuationRequiredAction,
  workflowActionClass,
} from "@/lib/workflow-invariants";
import {
  writeTaskExecutionState,
  type ExecutionState,
} from "@/lib/agents/watchdog/state";

interface TransitionInput {
  taskId: string;
  projectId?: string | null;
  action: string;
  /** The status the task landed in, read AFTER the action. */
  status: string | null;
  /** True when an unresolved formal blocker is waiting on external input. */
  blockedExternally?: boolean;
  at?: Date;
}

interface TransitionState {
  state: ExecutionState;
  reasonCode: string;
  reasonDetail: string;
}

/**
 * Map (action, resulting status) onto the operator-visible state.
 *
 * Pure and exported so the tests can assert the mapping without a database —
 * same discipline as the detectors.
 */
export function executionStateForWorkflowAction(
  input: Pick<TransitionInput, "action" | "status" | "blockedExternally">,
): TransitionState {
  // An unresolved external dependency outranks everything else: whatever the
  // agent's last action was, the task is not going to move without a human.
  if (input.blockedExternally) {
    return {
      state: "blocked",
      reasonCode: "external_dependency",
      reasonDetail: "a formal blocker is waiting on external input",
    };
  }
  if (input.action === "flag_blocker" || input.action === "flag_extra_work_blocker") {
    return {
      state: "blocked",
      reasonCode: "blocker_flagged",
      reasonDetail: "the assignee flagged a blocker and is waiting on a decision",
    };
  }
  if (input.status === "Review") {
    return {
      state: "waiting_review",
      reasonCode: "awaiting_review",
      reasonDetail: "implementation is complete and waiting on the reviewer",
    };
  }
  if (input.status === "Done") {
    return {
      state: "idle",
      reasonCode: "task_done",
      reasonDetail: "the task is Done; nothing is scheduled",
    };
  }
  // A continuation-required action means the agent is mid-episode and expected
  // to keep going. That is the one case where "running" is asserted from the
  // action itself rather than from an observed run row.
  if (isContinuationRequiredAction(input.action)) {
    return {
      state: "running",
      reasonCode: "turn_in_progress",
      reasonDetail: `the assignee is working; last action was ${input.action.replaceAll("_", " ")}`,
    };
  }
  if (workflowActionClass(input.action) === "episode-terminal") {
    return {
      state: "idle",
      reasonCode: "turn_handed_back",
      reasonDetail: `the turn ended on ${input.action.replaceAll("_", " ")}`,
    };
  }
  return {
    state: "idle",
    reasonCode: "no_work_scheduled",
    reasonDetail: "no execution turn is running or scheduled",
  };
}

/**
 * Record a successful workflow action on the task's execution state.
 *
 * Fail-soft by contract: the action has ALREADY committed by the time this
 * runs, so a failure here must never turn a successful transition into an error
 * response. The next watchdog pass corrects the row regardless.
 */
export async function recordWorkflowActionExecutionState(
  input: TransitionInput,
): Promise<boolean> {
  const at = input.at ?? new Date();
  const next = executionStateForWorkflowAction(input);
  try {
    const existing = await db.taskExecutionState.findUnique({
      where: { taskId: input.taskId },
      select: { recoveryAction: true, recoveryAt: true, detectorId: true },
    });
    // The agent has acted, so any recovery note on the row describes a past
    // intervention. Keep it only while the state is still not healthy — that is
    // where an operator still needs to know a repair was attempted.
    const keepRecovery = next.state === "stalled" || next.state === "blocked";
    return await writeTaskExecutionState({
      taskId: input.taskId,
      projectId: input.projectId ?? null,
      state: next.state,
      reasonCode: next.reasonCode,
      reasonDetail: next.reasonDetail,
      lastDurableAction: input.action,
      lastDurableActionAt: at,
      recoveryAction: keepRecovery ? (existing?.recoveryAction ?? null) : null,
      recoveryAt: keepRecovery ? (existing?.recoveryAt ?? null) : null,
      detectorId: keepRecovery ? (existing?.detectorId ?? null) : null,
    });
  } catch (error) {
    console.warn("[watchdog] execution-state transition write failed", error);
    return false;
  }
}
