// ENV-118 — the explicit result of a workflow action.
//
// Before this module, `recordPmChannelRunWorkflowAction` settled the run AND
// its job `complete` for every action in the route's ACTIONS list, `start`
// included. That reported a successful turn for work that had not begun.
//
// The fix is to make the EFFECT of an action first-class. ENV-116 already
// classified every action as "continuation-required" or "episode-terminal"
// (lib/workflow-invariants.ts). That binary is the right spec, but the runtime
// needs a third case: an action that legitimately ends the agent's turn while
// handing the workflow to somebody else, which must settle the run without
// pretending the task itself is finished.
//
//   continue — a step INSIDE the episode. The run keeps its lease, a
//              continuation is armed, and PM schedules a fresh execution turn
//              if the turn then ends without an episode-terminal action.
//   wait     — the episode ends because an external actor must respond.
//   finish   — the episode ends with the agent handing control back to PM.
//
// The mapping is DERIVED from WORKFLOW_ACTION_CLASS rather than restated, so
// the two tables can never disagree about which actions are continuations.

import {
  WORKFLOW_ACTION_CLASS,
  workflowActionClass,
  type WorkflowDisposition,
} from "@/lib/workflow-invariants";

export type WorkflowActionEffect = "continue" | "wait" | "finish";

/**
 * Episode-terminal actions that end the turn because somebody ELSE must act
 * next. Everything else that is episode-terminal is a plain `finish`.
 */
const WAIT_ACTIONS = new Set([
  "flag_blocker",
  "flag_extra_work_blocker",
  "request_subtask",
  "request_task",
]);

/**
 * Actions the epic workflow route owns. They are not in WORKFLOW_ACTION_CLASS
 * (which is scoped to the task lifecycle) and every one of them hands control
 * straight back to PM, so they are all plain finishes.
 */
const EPIC_ACTIONS = [
  "advance_queue",
  "assign_next",
  "create_tasks",
  "deploy_review_approve",
  "deploy_review_reject",
] as const;

function deriveEffect(action: string): WorkflowActionEffect | null {
  const actionClass = workflowActionClass(action);
  if (actionClass === "continuation-required") return "continue";
  if (actionClass === "episode-terminal") {
    return WAIT_ACTIONS.has(action) ? "wait" : "finish";
  }
  return (EPIC_ACTIONS as readonly string[]).includes(action) ? "finish" : null;
}

export const WORKFLOW_ACTION_EFFECT: Readonly<Record<string, WorkflowActionEffect>> =
  Object.freeze(
    Object.fromEntries(
      [...Object.keys(WORKFLOW_ACTION_CLASS), ...EPIC_ACTIONS].map((action) => [
        action,
        // Non-null by construction: every key here comes from one of the two
        // tables deriveEffect covers. The completeness test proves it.
        deriveEffect(action) as WorkflowActionEffect,
      ]),
    ),
  );

export function workflowActionEffect(
  action: string | null | undefined,
): WorkflowActionEffect | null {
  if (!action) return null;
  return WORKFLOW_ACTION_EFFECT[action] ?? null;
}

/**
 * Unknown actions are treated as `finish`. A route only reaches the recorder
 * with an action from its own ACTIONS list, so this is a defensive default
 * rather than a real case — and settling is the safe side: an unclassified
 * action must never leave a run pinned open forever.
 */
export function workflowActionEffectOrFinish(action: string): WorkflowActionEffect {
  return workflowActionEffect(action) ?? "finish";
}

export function isContinuationEffect(action: string | null | undefined): boolean {
  return workflowActionEffect(action) === "continue";
}

/** The end-of-turn disposition an action implies. */
export function workflowActionDisposition(action: string): WorkflowDisposition {
  switch (workflowActionEffectOrFinish(action)) {
    case "continue":
      return "continue";
    case "wait":
      return "waiting_external";
    case "finish":
      return action === "ready_for_review" || action === "submit_review"
        ? "ready_for_review"
        : "completed";
  }
}

/**
 * A stable, machine-readable name for the durable state the action reached.
 * The agent gets this back so a resumed or retried turn can tell what already
 * happened without re-deriving it from prose.
 */
const CHECKPOINTS: Readonly<Record<string, string>> = {
  start: "task_started",
  add_subtask: "checklist_updated",
  complete_subtask: "checklist_updated",
  remove_subtask: "checklist_updated",
  clear_blocker: "blocker_cleared",
  publish_checkpoint: "checkpoint_published",
  checkpoint: "execution_checkpoint_saved",
  ready_for_review: "submitted_for_review",
  submit_review: "submitted_for_review",
  review_feedback: "review_feedback_recorded",
  review_done: "task_accepted",
  triage_to_todo: "task_triaged",
  approve_plan: "plan_approved",
  submit_plan: "plan_submitted",
  assign_task: "task_assigned",
  assign_after_plan_approval: "task_assigned",
  request_subtask: "subtask_requested",
  request_task: "task_requested",
  flag_blocker: "blocker_raised",
  flag_extra_work_blocker: "extra_work_blocker_raised",
};

export function workflowActionCheckpoint(action: string): string {
  return CHECKPOINTS[action] ?? "workflow_action_recorded";
}

/**
 * What the agent should do next. `continue` actions deliberately do NOT name a
 * single next action — the agent is mid-episode and owns that choice — so they
 * return the terminal action that would legitimately end the episode.
 */
export function workflowActionNextAction(action: string): string {
  switch (workflowActionEffectOrFinish(action)) {
    case "continue":
      return "ready_for_review";
    case "wait":
      return action === "flag_blocker" || action === "flag_extra_work_blocker"
        ? "clear_blocker"
        : "await_response";
    case "finish":
      return "none";
  }
}

/**
 * ENV-121 — what the server-side cycle counter says about the agent's current
 * execution episode. Echoed on every action result so an agent learns it is
 * near rollover from the response body, not from guessing.
 *
 * Structurally typed rather than imported from the episode module: that module
 * imports `workflowActionCheckpoint` from here, and a type import back would
 * make the cycle real.
 */
export interface WorkflowActionEpisodeProgress {
  episodeNo: number;
  cycleCount: number;
  cycleBudget: number;
  cyclesRemaining: number;
  /**
   * The finer PM-visible unit: `tool:call` stream events observed during this
   * episode. Workflow actions are the coarse backstop; this is the budget a
   * tool-heavy turn actually spends.
   */
  toolCycleCount: number;
  toolCycleBudget: number;
  toolCyclesRemaining: number;
  /** True when this action exhausted the budget and PM rolled the episode over. */
  rolledOver: boolean;
  /** The successor episode number, when a rollover happened. */
  nextEpisodeNo: number | null;
}

export interface WorkflowActionResult {
  /** Whether the agent's execution episode continues, waits, or is over. */
  actionEffect: WorkflowActionEffect;
  /** Episode/cycle accounting for this action, when the action ran on a task. */
  episode?: WorkflowActionEpisodeProgress | null;
  /** The task's status after the action, when the caller knows it. */
  taskState: string | null;
  /** Stable name of the durable state this action reached. */
  checkpoint: string;
  /** The action the agent should take next. */
  nextAction: string;
  /** The end-of-turn disposition this action implies. */
  disposition: WorkflowDisposition;
  /**
   * True when the turn must not be treated as finished. The route echoes this
   * so an agent (or a driver) reading only the response body still learns that
   * `ok: true` is not the end of the job.
   */
  turnComplete: boolean;
}

export function workflowActionResult(args: {
  action: string;
  taskState?: string | null;
}): WorkflowActionResult {
  const actionEffect = workflowActionEffectOrFinish(args.action);
  return {
    actionEffect,
    taskState: args.taskState ?? null,
    checkpoint: workflowActionCheckpoint(args.action),
    nextAction: workflowActionNextAction(args.action),
    disposition: workflowActionDisposition(args.action),
    turnComplete: actionEffect !== "continue",
  };
}
