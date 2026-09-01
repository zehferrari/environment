// Project-environment context + planning prompt for agent work-item
// proposals (Slice 2).
//
// When a direct chat or Task/Epic Discussion message grants "manage work
// items", the agent's turn carries this project-environment packet (repo
// path, git identity, picker defaults, existing epics/open tasks,
// assignable principals) plus a planning prompt that hands the agent the
// propose endpoint + grant token + the change-set op schema.
//
// PM owns this context; the agent proposes against it, and a human
// approves before anything is written (see lib/work-items/apply.ts).

import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import { resolveGitIdentity } from "@/lib/settings/system";

const MAX_EPICS = 40;
const MAX_TASKS = 80;
// Keep breadth ahead of depth: every scoped epic/task should be visible even
// when one early item has a very long description.
const MAX_EPIC_DESCRIPTION = 1200;
const MAX_TASK_DESCRIPTION = 800;

type ClipResult = { text: string; truncated: boolean; omittedChars: number };

function clipWithMeta(value: string, max = 2000): ClipResult {
  const text = value.trim();
  if (text.length <= max) return { text, truncated: false, omittedChars: 0 };
  return {
    text: `${text.slice(0, max).trimEnd()}\n[truncated: ${text.length - max} more chars]`,
    truncated: true,
    omittedChars: text.length - max,
  };
}

function clip(value: string, max = 2000) {
  return clipWithMeta(value, max).text;
}

export interface ProjectEnvContext {
  projectId: string;
  projectSlug: string;
  projectName: string;
  text: string;
}

export async function buildProjectEnvContext(
  projectId: string,
): Promise<ProjectEnvContext | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      readmePath: true,
      repositoryPath: true,
      workItemKeyPrefix: true,
      onlyReportersCanApproveActionPlans: true,
      onlyReportersCanSetTasksDone: true,
      onlyReportersCanApprovePullRequests: true,
      defaultGitUserName: true,
      defaultGitUserEmail: true,
      deletedAt: true,
      defaultAssignee: { select: { username: true } },
      defaultReviewer: { select: { username: true } },
      managerAssignableAgents: {
        select: { user: { select: { username: true } } },
        orderBy: { user: { username: "asc" } },
      },
    },
  });
  if (!project || project.deletedAt) return null;

  const [epics, tasks, principals] = await Promise.all([
    db.epic.findMany({
      where: { projectId, archivedAt: null, deletedAt: null, private: false },
      orderBy: { createdAt: "asc" },
      take: MAX_EPICS,
      select: {
        id: true,
        workItemKey: true,
        title: true,
        status: true,
        description: true,
        approvedOn: true,
        completionReviewStatus: true,
        completionReviewCandidateSha: true,
        actingManager: { select: { username: true } },
        deployReviewer: { select: { username: true } },
      },
    }),
    db.task.findMany({
      where: {
        projectId,
        parentTaskId: null,
        archivedAt: null,
        deletedAt: null,
        status: { not: "Done" },
        private: false,
        OR: [{ epicId: null }, { epic: { private: false } }],
      },
      orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
      take: MAX_TASKS,
      select: {
        id: true,
        workItemKey: true,
        title: true,
        status: true,
        description: true,
        epicId: true,
        parentTaskId: true,
      },
    }),
    listAssignablePrincipals(),
  ]);

  // Git identity falls back to the system default when the project leaves
  // it blank (lib/settings/system.ts).
  const git = await resolveGitIdentity(project);

  const lines: string[] = [
    "PROJECT ENVIRONMENT (target project for work-item proposals):",
    `Project: ${project.name} (slug: ${project.slug})`,
    `Project id: ${project.id}`,
    `Project key prefix: ${project.workItemKeyPrefix || "(not set)"}`,
    `Repository path: ${project.repositoryPath || "(not set)"}`,
    `Default git identity: ${git.name || "(not set)"} <${git.email || "(not set)"}>`,
    `Policy - only reporters can approve Action Plans: ${project.onlyReportersCanApproveActionPlans ? "yes" : "no"}`,
    `Policy - only reporters can set Tasks to Done: ${project.onlyReportersCanSetTasksDone ? "yes" : "no"}`,
    `Policy - only reporters can approve Pull Requests: ${project.onlyReportersCanApprovePullRequests ? "yes" : "no"}`,
    `Default assignee: ${project.defaultAssignee?.username ? `@${project.defaultAssignee.username}` : "(none)"}`,
    `Default reviewer: ${project.defaultReviewer?.username ? `@${project.defaultReviewer.username}` : "(none)"}`,
    `Manager assignment pool: ${
      project.managerAssignableAgents.length > 0
        ? project.managerAssignableAgents.map((row) => `@${row.user.username}`).join(", ")
        : "(unrestricted active coding agents)"
    }`,
    `README path: ${project.readmePath || "(not set)"}`,
  ];
  if (project.description?.trim()) {
    lines.push("Project description:", "-----", clip(project.description, 2000), "-----");
  }

  lines.push(
    "",
    "ASSIGNABLE PRINCIPALS (valid usernames for assignee / actingManager / deployReviewer):",
  );
  if (principals.length === 0) lines.push("(none)");
  else for (const p of principals) {
    lines.push(`- @${p.username}${p.kind === "agent" ? " (agent)" : ""}`);
  }

  const tasksByEpic = new Map<string, typeof tasks>();
  const rootTasks: typeof tasks = [];
  for (const task of tasks) {
    if (task.epicId) {
      const existing = tasksByEpic.get(task.epicId) ?? [];
      existing.push(task);
      tasksByEpic.set(task.epicId, existing);
    } else {
      rootTasks.push(task);
    }
  }

  lines.push("", "CONTEXT MANIFEST (breadth first; all fetched items):");
  lines.push(`Epics fetched: ${epics.length}${epics.length === MAX_EPICS ? " (limit reached)" : ""}`);
  if (epics.length === 0) lines.push("- Epics: (none)");
  else for (const e of epics) {
    const childTasks = tasksByEpic.get(e.id) ?? [];
    lines.push(`- Epic [${e.status}] ${e.title} (key: ${e.workItemKey || "not assigned"}; id: ${e.id}; approved_on: ${e.approvedOn ? e.approvedOn.toISOString() : "not approved"}; acting manager: ${e.actingManager?.username ? `@${e.actingManager.username}` : "none"}; deploy reviewer: ${e.deployReviewer?.username ? `@${e.deployReviewer.username}` : "Monitor Agent fallback"}; acceptance: ${e.completionReviewStatus}${e.completionReviewCandidateSha ? ` at ${e.completionReviewCandidateSha}` : ""}; open tasks fetched: ${childTasks.length})`);
    for (const t of childTasks) {
      lines.push(`  - Task [${t.status}] ${t.title} (key: ${t.workItemKey || "not assigned"}; id: ${t.id}${t.parentTaskId ? `; parent: ${t.parentTaskId}` : ""})`);
    }
  }
  if (rootTasks.length > 0) {
    lines.push(`- Root open tasks without epic: ${rootTasks.length}`);
    for (const t of rootTasks) {
      lines.push(`  - Task [${t.status}] ${t.title} (key: ${t.workItemKey || "not assigned"}; id: ${t.id}${t.parentTaskId ? `; parent: ${t.parentTaskId}` : ""})`);
    }
  }
  if (tasks.length === MAX_TASKS) {
    lines.push(`[partial context: task fetch limit reached at ${MAX_TASKS}; additional open tasks may exist]`);
  }
  lines.push("Task-level sub-tasks are not listed as Epic implementation tasks. Fetch the parent task context when sub-task checklist state matters.");

  let truncatedEpicDescriptions = 0;
  let truncatedTaskDescriptions = 0;

  lines.push("", `EXISTING EPICS (${epics.length}; per-item descriptions capped):`);
  if (epics.length === 0) lines.push("(none)");
  else for (const e of epics) {
    lines.push(`- [${e.status}] ${e.title} (key: ${e.workItemKey || "not assigned"}; id: ${e.id}; approved_on: ${e.approvedOn ? e.approvedOn.toISOString() : "not approved"}; acting manager: ${e.actingManager?.username ? `@${e.actingManager.username}` : "none"}; deploy reviewer: ${e.deployReviewer?.username ? `@${e.deployReviewer.username}` : "Monitor Agent fallback"}; acceptance: ${e.completionReviewStatus}${e.completionReviewCandidateSha ? ` at ${e.completionReviewCandidateSha}` : ""})`);
    if (e.description?.trim()) {
      const clipped = clipWithMeta(e.description, MAX_EPIC_DESCRIPTION);
      if (clipped.truncated) truncatedEpicDescriptions += 1;
      lines.push(
        `  Description for epic ${e.id}:`,
        `<<<EPIC_DESCRIPTION_${e.id}`,
        clipped.text,
        `EPIC_DESCRIPTION_${e.id}>>>`,
      );
    } else {
      lines.push(`  Description for epic ${e.id}: (empty)`);
    }
  }

  lines.push("", `EXISTING ACTIVE TASKS (${tasks.length}; excludes Done; per-item descriptions capped):`);
  if (tasks.length === 0) lines.push("(none)");
  else for (const t of tasks) {
    const rel = [
      t.epicId ? `epic: ${t.epicId}` : "",
      t.parentTaskId ? `parent: ${t.parentTaskId}` : "",
    ].filter(Boolean).join(", ");
    lines.push(`- [${t.status}] ${t.title} (key: ${t.workItemKey || "not assigned"}; id: ${t.id}${rel ? `, ${rel}` : ""})`);
    if (t.description?.trim()) {
      const clipped = clipWithMeta(t.description, MAX_TASK_DESCRIPTION);
      if (clipped.truncated) truncatedTaskDescriptions += 1;
      lines.push(
        `  Description for task ${t.id}:`,
        `<<<TASK_DESCRIPTION_${t.id}`,
        clipped.text,
        `TASK_DESCRIPTION_${t.id}>>>`,
      );
    }
  }

  if (truncatedEpicDescriptions > 0 || truncatedTaskDescriptions > 0 || epics.length === MAX_EPICS || tasks.length === MAX_TASKS) {
    lines.push(
      "",
      `[partial context: ${truncatedEpicDescriptions} epic descriptions truncated; ${truncatedTaskDescriptions} task descriptions truncated; fetched ${epics.length}/${MAX_EPICS} epics and ${tasks.length}/${MAX_TASKS} open tasks]`,
    );
  }

  return {
    projectId: project.id,
    projectSlug: project.slug,
    projectName: project.name,
    text: lines.join("\n"),
  };
}

// The grant prompt handed to the agent in the planning turn. This is the
// sanctioned "write action" pattern from docs/agent-interaction.md: a
// typed endpoint + a token scoped to the action, delivered in the turn.
export function buildWorkItemPlanningPrompt(args: {
  agentSlug: string;
  projectSlug: string;
  proposeUrl: string;
  grantMessageId: string;
  token: string;
  autoApply?: boolean;
  autoApplyTaskCreates?: boolean;
  publicOrigin?: string | null;
}): string {
  const appliesAllImmediately = args.autoApply === true;
  const appliesTaskCreatesImmediately = appliesAllImmediately || args.autoApplyTaskCreates === true;
  const exampleBody = JSON.stringify(
    {
      grantMessageId: args.grantMessageId,
      token: args.token,
      publicOrigin: args.publicOrigin ?? "<public browser origin provided by PM>",
      planId: "<a fresh unique id for this proposal, e.g. a uuid>",
      summary: "<one-line summary of the change-set>",
      operations: [
        { op: "create_epic", ref: "tmp:epic1", title: "Epic title", description: "..." },
        { op: "create_task", ref: "tmp:task1", title: "Unblock the release" },
        { op: "create_task", ref: "tmp:task2", title: "Ship the release", blockedBy: "tmp:task1" },
        { op: "create_subtask", ref: "tmp:sub1", parent: "<existing top-level Task id>", title: "Sub-task title" },
      ],
    },
    null,
    2,
  );

  return [
    `WORK-ITEM PLANNING GRANT for @${args.agentSlug} on project "${args.projectSlug}".`,
    appliesAllImmediately
      ? "A human-authored direct message in this project-scoped chat gives you a one-shot capability to execute requested work-item changes immediately without an additional approval step."
      : appliesTaskCreatesImmediately
        ? "A human-authored message in this project-scoped chat gives you a one-shot capability to execute requested task creation immediately; other work-item changes remain proposals."
        : "A human-authored message in this project-scoped chat gives you a one-shot capability to PROPOSE work-item changes.",
    "Use it only when the current human message directly asks you to create, update, reorganize, comment on, or otherwise change project work items. If the message is only a question, discussion, or status check, do not submit a proposal.",
    "Source of truth for project state: GET /api/agents/context/project/<projectId> via the loopback fetch shown in the LIVE PM CONTEXT block in your system prompt. The proposal endpoint below is the only project-WRITE endpoint you should call from this turn.",
    appliesAllImmediately
      ? "For direct-chat grants, valid operations are applied immediately. The endpoint response includes links for created items when available; include those links in your visible reply."
      : appliesTaskCreatesImmediately
        ? "A change-set containing only create_task operations is applied immediately and returns links for the new tasks. Other valid change-sets wait for human review."
        : "Nothing changes on the board until the user reviews and approves your proposal, so make the breakdown clear and well structured when you do propose.",
    "",
    "HOW TO SUBMIT (only when the current human message explicitly requests work-item changes; otherwise ignore this section):",
    `POST application/json to: ${args.proposeUrl}`,
    "Body shape:",
    exampleBody,
    args.publicOrigin
      ? `PUBLIC_ORIGIN for returned created-resource links: ${args.publicOrigin}. Send this exact value as publicOrigin in the JSON body.`
      : "Send publicOrigin in the JSON body only when PM provides a PUBLIC_ORIGIN value.",
    "",
    `OPERATIONS (a change-set applied in order and all-or-nothing; ${appliesAllImmediately ? "immediately after validation" : appliesTaskCreatesImmediately ? "task-creation-only batches apply immediately; other batches apply on approval" : "on approval"}):`,
    "- create_epic    { ref, title, description? }",
    "- create_task    { ref, title, description?, epic?, blockedBy? }   (epic/blocker optional; top-level task)",
    "- create_subtask { ref, parent, title, description? }  (parent required)",
    "- update_epic    { target, title?, description?, actingManager?, deployReviewer? }",
    "- update_task    { target, title?, description?, assignee?, actingManager?, epic?, parent?, blockedBy?, status? }",
    "- comment_task   { target, body }",
    "",
    "REFERENCES:",
    '- New items you create take a "ref" that MUST start with "tmp:" (e.g. "tmp:epic1"). Reference them from later ops (epic / parent / blockedBy) by that ref.',
    "- To touch existing items, use their real id from the PROJECT ENVIRONMENT block above (target / epic / parent / blockedBy).",
    "- assignee / actingManager / deployReviewer are usernames from the ASSIGNABLE PRINCIPALS list, or null to leave unset.",
    "",
    "RULES (your proposal is validated against these; violations are flagged for the user):",
    "- You may propose changes anywhere in the project when the current human message explicitly asks for them.",
    "- Never set yourself as reporter, assignee, reviewer, or acting manager.",
    "- Never change Epic status.",
    "- New Epics/Tasks/Subtasks created by you must not include assignee, actingManager, or deployReviewer. PM records the requesting human as reporter automatically.",
    "- For existing item updates only, keep requested assignee / actingManager / deployReviewer values exactly as the human asked; otherwise leave them null.",
    "- create_task can link to an existing Epic or to a newly created Epic in the same proposal when the human asked for that breakdown.",
    "- blockedBy sets a hard task dependency. Use an existing visible task id or a create_task tmp ref from this proposal; null clears it on update_task. PM rejects private, cross-project, missing/deleted/archived, self, and circular dependencies.",
    "- create_subtask must reference a top-level Task, either existing or newly created in the same proposal. Do not create subtasks under another subtask.",
    appliesAllImmediately
      ? "- Direct-chat requests are applied immediately after validation. Do not tell the user it is awaiting approval."
      : appliesTaskCreatesImmediately
        ? "- A batch containing only create_task operations is applied immediately after validation. Do not tell the user it is awaiting approval; include the returned task links. Other operation types remain pending for review."
        : "- Nothing is applied until the human reviews and approves the proposal.",
    "- New tasks and epics start in Backlog.",
    "- Use a fresh, unique planId per proposal; re-POSTing the same planId is idempotent (no duplicate).",
    "",
    appliesAllImmediately
      ? "Only if you actually submit operations: briefly tell the user what changed and include returned links for created resources when possible. If you did not submit operations, do not mention this grant or endpoint."
      : appliesTaskCreatesImmediately
        ? "If you submit only create_task operations, briefly tell the user what was created and include returned links. For any other submitted proposal, say that it awaits review. If you submit nothing, do not mention this grant or endpoint."
        : "Only if you actually submit a proposal: briefly tell the user what you proposed and that it is awaiting their review. If you did not submit a proposal, do not mention this grant, endpoint, or review flow.",
  ].join("\n");
}
