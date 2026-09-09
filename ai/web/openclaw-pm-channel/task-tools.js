// Native tools are bound to one authenticated ingress generation, never tool arguments.
const string = { type: "string" };
const strings = { type: "array", items: string };
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const comment = { comment: string };
const checkpoint = { completedWork: strings, evidence: strings, openChecklist: strings, nextAction: string, risks: strings };
const plan = object({ summary: string, steps: { type: "array", minItems: 1, maxItems: 20, items: object({
  id: string, title: string, acceptanceCriteria: strings, kind: { type: "string", enum: ["sequential", "parallel"] }, assigneeId: { type: ["string", "null"] },
}, ["id", "title", "acceptanceCriteria", "kind"]) } }, ["summary", "steps"]);
export const PM_TASK_TOOL_DEFINITIONS = {
  context: ["Read current task, plan, checklist, or history only when a named fact is missing.", object({ section: { type: "string", enum: ["current", "plan", "history"] } })],
  submit_plan: ["Submit or revise the structured Action Plan. Finish this turn after acceptance.", object({ actionPlan: plan }, ["actionPlan"])],
  approve_plan: ["Approve the current plan as the authorized reviewer; PM prepares the worktree.", object({ constraints: string })],
  request_plan_changes: ["Return the current Action Plan for one consolidated revision, with exact feedback.", object(comment, ["comment"])],
  review_feedback: ["Request specific changes to the reviewed implementation.", object(comment, ["comment"])],
  start: ["Start the approved task. Continue implementation when actionEffect is continue.", object({})],
  checkpoint: ["Save decisions, file/test evidence and the exact next action before a handoff.", object(checkpoint, ["nextAction"])],
  complete_subtask: ["Record completed checklist work without ending the working session.", object({ subtaskId: string, completed: { type: "boolean" }, minutesSpent: { type: "number" } }, ["subtaskId"])],
  add_subtask: ["Add a necessary implementation or review checklist item.", object({ subtaskText: string, subtaskKind: { type: "string", enum: ["implementation", "review"] } }, ["subtaskText"])],
  ready_for_review: ["Submit completed work and test evidence. PM owns commit, validation and publication.", object({ ...comment, repoTouched: { type: "boolean" } }, ["comment"])],
  review_done: ["Accept the reviewed candidate with concise evidence; PM finalizes the repository.", object(comment, ["comment"])],
  flag_blocker: ["Record a concrete external blocker after diagnosis, or request scoped owner permission.", object({
    ...comment, blockerReport: object({ blockedOn: { type: "string", enum: ["person", "permission", "external_service", "decision", "dependency"] }, requestedActor: string, requestedAction: string, evidence: string, diagnosticsAttempted: strings, resumeCondition: string, reporterCanResolve: { type: "boolean" } }),
    permissionKind: { type: "string", enum: ["reporter_approval", "publish_checkpoint"] }, permissionScope: string,
  }, ["comment"])],
  clear_blocker: ["Resolve a recorded blocker with evidence.", object(comment, ["comment"])],
  assign_task: ["Ask PM to select an eligible coding assignee for an unassigned task.", object({ assigneeUsername: string })],
  publish_checkpoint: ["Publish only the exact checkpoint authorized by a fresh owner permission comment.", object({ authorizationCommentId: string, ...comment }, ["authorizationCommentId"])],
};
export const PM_TASK_TOOL_NAMES = Object.keys(PM_TASK_TOOL_DEFINITIONS).map((action) => `pm_${action}`);

export function validateTaskRuntime(runtime, target) {
  if (!runtime || runtime.version !== 1 || !target || !["task-chat", "task-comment"].includes(target.kind)) return null;
  if (runtime.taskId !== target.taskId || runtime.messageId !== target.messageId || runtime.agentSlug !== target.agentSlug) return null;
  if (typeof runtime.token !== "string" || !runtime.token || !Array.isArray(runtime.actions) || !runtime.actions.every((a) => Object.hasOwn(PM_TASK_TOOL_DEFINITIONS, a))) return null;
  if (runtime.actionPlan != null && (typeof runtime.actionPlan.id !== "string" || !Number.isInteger(runtime.actionPlan.version) || runtime.actionPlan.version < 1)) return null;
  try {
    const workflow = new URL(runtime.workflowUrl);
    const context = new URL(runtime.contextUrl);
    if (![workflow, context].every((u) => u.protocol === "http:" && u.hostname === "127.0.0.1" && !u.username && !u.password && !u.hash)) return null;
    if (workflow.origin !== context.origin || workflow.search || workflow.pathname !== `/api/agent/tasks/${encodeURIComponent(target.taskId)}/workflow` || context.pathname !== `/api/agents/context/task/${encodeURIComponent(target.taskId)}`) return null;
    if (!context.searchParams.get("grant")) return null;
  } catch { return null; }
  return runtime;
}

function redact(value, runtime) {
  // Error messages and context may mention grants; never echo a runtime credential.
  let text = JSON.stringify(value);
  for (const secret of [runtime.token, runtime.contextUrl, new URL(runtime.contextUrl).searchParams.get("grant")]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return JSON.parse(text);
}

export function createTaskTools({ context, findTurn, fetchImpl = fetch }) {
  if (context.messageChannel !== "pm" || !context.sessionKey) return null;
  const turn = findTurn(context.sessionKey);
  if (!turn || turn.abortedAt) return null;
  const runtime = validateTaskRuntime(turn.taskRuntime, turn.replyTarget);
  if (!runtime) return null;
  const generation = turn.acceptedId;
  let reviewedPlan = runtime.actionPlan;
  return runtime.actions.map((action) => {
    const [description, parameters] = PM_TASK_TOOL_DEFINITIONS[action];
    return {
      name: `pm_${action}`, label: `PM ${action.replaceAll("_", " ")}`, description, parameters,
      async execute(_toolCallId, args = {}, signal) {
        const current = findTurn(context.sessionKey);
        if (current !== turn || current.acceptedId !== generation || current.abortedAt) throw new Error("PM turn was replaced or canceled; no action was sent.");
        if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !(Object.hasOwn(parameters.properties, key)))) throw new Error("Invalid PM tool arguments; task identity and credentials are supplied by the runtime.");
        if (parameters.required.some((key) => args[key] === undefined)) throw new Error("A required PM tool argument is missing.");
        const url = new URL(action === "context" ? runtime.contextUrl : runtime.workflowUrl);
        if (action === "context" && args.section === "history") url.searchParams.set("history", "full");
        const planDecision = ["approve_plan", "request_plan_changes"].includes(action);
        if (planDecision && !reviewedPlan) throw new Error("Read the current plan with pm_context section=plan before deciding.");
        const planEvidence = planDecision ? { actionPlanId: reviewedPlan.id, actionPlanVersion: reviewedPlan.version } : {};
        let response;
        // The same payload is safe to replay through PM's command receipt after a
        // lost response. Abort/cancel and business errors are never retried here.
        for (let attempt = 0; attempt < 2; attempt++) {
          if (signal?.aborted || findTurn(context.sessionKey) !== turn || turn.abortedAt) throw new Error("PM turn is no longer active.");
          try {
            response = await fetchImpl(url.toString(), {
              method: action === "context" ? "GET" : "POST", redirect: "error",
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
              ...(action === "context" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ ...args, ...planEvidence, action, messageId: runtime.messageId, token: runtime.token }) }),
            });
            break;
          } catch {
            if (attempt === 1 || signal?.aborted) throw new Error("PM request failed; retry this same tool call if the turn is still active.");
          }
        }
        const result = await response.json().catch(() => ({ error: "PM returned an unreadable response." }));
        let data = result;
        if (action === "context" && response.ok) {
          reviewedPlan = result.actionPlan ? { id: result.actionPlan.id, version: result.actionPlan.version } : null;
          if (args.section === "plan") data = { actionPlan: result.actionPlan };
          else if (args.section !== "history") data = { task: result.task, actionPlan: result.actionPlan, checklist: result.checklist, recentComments: result.recentComments, currentThread: result.currentThread };
        }
        const safe = redact(data, runtime);
        return { content: [{ type: "text", text: JSON.stringify(safe) }], details: { status: response.status }, ...(response.ok ? {} : { isError: true }) };
      },
    };
  });
}

// OpenClaw selects tool-bearing plugins from manifest contracts before it
// invokes registerTool factories. The handshake must reflect that prerequisite.
export function taskToolCapabilities(manifest) {
  const declared = new Set(Array.isArray(manifest?.contracts?.tools) ? manifest.contracts.tools : []);
  const taskTools = PM_TASK_TOOL_NAMES.filter((name) => declared.has(name));
  return { taskRuntimeVersions: taskTools.length === PM_TASK_TOOL_NAMES.length ? [1] : [], taskTools };
}
