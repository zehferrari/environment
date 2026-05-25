// Project-environment context + planning prompt for agent work-item
// proposals (Slice 2).
//
// When a direct chat is attached to a project and the user grants
// "manage work items", the agent's turn carries this project-environment
// packet (repo path, git identity, picker defaults, existing epics/open
// tasks, assignable principals) plus a planning prompt that hands the
// agent the propose endpoint + grant token + the change-set op schema.
//
// PM owns this context; the agent proposes against it, and a human
// approves before anything is written (see lib/work-items/apply.ts).

import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import { resolveGitIdentity } from "@/lib/settings/system";

const MAX_EPICS = 40;
const MAX_TASKS = 80;

function clip(value: string, max = 2000) {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n[truncated]`;
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
      defaultGitUserName: true,
      defaultGitUserEmail: true,
      deletedAt: true,
      defaultAssignee: { select: { username: true } },
      defaultReviewer: { select: { username: true } },
    },
  });
  if (!project || project.deletedAt) return null;

  const [epics, tasks, principals] = await Promise.all([
    db.epic.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: MAX_EPICS,
      select: { id: true, title: true, status: true },
    }),
    db.task.findMany({
      where: { projectId, deletedAt: null, status: { not: "Done" } },
      orderBy: [{ status: "asc" }, { rank: "asc" }],
      take: MAX_TASKS,
      select: { id: true, title: true, status: true, epicId: true, parentTaskId: true },
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
    `Repository path: ${project.repositoryPath || "(not set)"}`,
    `Default git identity: ${git.name || "(not set)"} <${git.email || "(not set)"}>`,
    `Default assignee: ${project.defaultAssignee?.username ? `@${project.defaultAssignee.username}` : "(none)"}`,
    `Default reviewer: ${project.defaultReviewer?.username ? `@${project.defaultReviewer.username}` : "(none)"}`,
    `README path: ${project.readmePath || "(not set)"}`,
  ];
  if (project.description?.trim()) {
    lines.push("Project description:", "-----", clip(project.description, 2000), "-----");
  }

  lines.push(
    "",
    "ASSIGNABLE PRINCIPALS (valid usernames for assignee / actingManager):",
  );
  if (principals.length === 0) lines.push("(none)");
  else for (const p of principals) {
    lines.push(`- @${p.username}${p.kind === "agent" ? " (agent)" : ""}`);
  }

  lines.push("", `EXISTING EPICS (${epics.length}):`);
  if (epics.length === 0) lines.push("(none)");
  else for (const e of epics) lines.push(`- [${e.status}] ${e.title} (id: ${e.id})`);

  lines.push("", `EXISTING OPEN TASKS (${tasks.length}; excludes Done):`);
  if (tasks.length === 0) lines.push("(none)");
  else for (const t of tasks) {
    const rel = [
      t.epicId ? `epic: ${t.epicId}` : "",
      t.parentTaskId ? `parent: ${t.parentTaskId}` : "",
    ].filter(Boolean).join(", ");
    lines.push(`- [${t.status}] ${t.title} (id: ${t.id}${rel ? `, ${rel}` : ""})`);
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
}): string {
  const exampleBody = JSON.stringify(
    {
      grantMessageId: args.grantMessageId,
      token: args.token,
      planId: "<a fresh unique id for this proposal, e.g. a uuid>",
      summary: "<one-line summary of the change-set>",
      operations: [
        { op: "create_epic", ref: "tmp:epic1", title: "Epic title", description: "..." },
        { op: "create_task", ref: "tmp:task1", title: "Task title", epic: "tmp:epic1", assignee: null },
        { op: "create_subtask", ref: "tmp:sub1", parent: "tmp:task1", title: "Sub-task title" },
      ],
    },
    null,
    2,
  );

  return [
    `WORK-ITEM PLANNING GRANT for @${args.agentSlug} on project "${args.projectSlug}".`,
    "The user authorised you to PROPOSE work-item changes for this project.",
    "Nothing changes on the board until the user reviews and approves your proposal — so propose freely, but make the breakdown clear and well structured.",
    "",
    "HOW TO SUBMIT (do this in addition to your normal chat reply):",
    `POST application/json to: ${args.proposeUrl}`,
    "Body shape:",
    exampleBody,
    "",
    "OPERATIONS (a change-set applied in order, all-or-nothing on approval):",
    "- create_epic    { ref, title, description?, assignee?, actingManager? }",
    "- create_task    { ref, title, description?, epic?, assignee?, actingManager? }   (epic optional; top-level task)",
    "- create_subtask { ref, parent, title, description?, assignee?, actingManager? }  (parent required)",
    "- update_epic    { target, title?, description?, assignee?, actingManager?, status? }   (status: open|done|archived)",
    "- update_task    { target, title?, description?, assignee?, actingManager?, epic?, parent?, status? }",
    "- comment_task   { target, body }",
    "",
    "REFERENCES:",
    '- New items you create take a "ref" that MUST start with "tmp:" (e.g. "tmp:epic1"). Reference them from later ops (epic / parent) by that ref.',
    "- To touch existing items, use their real id from the PROJECT ENVIRONMENT block above (target / epic / parent).",
    "- assignee / actingManager are usernames from the ASSIGNABLE PRINCIPALS list, or null to leave unset.",
    "",
    "RULES (your proposal is validated against these; violations are flagged for the user):",
    "- You cannot assign work to yourself or set yourself as reviewer / acting manager.",
    "- You cannot move a task into or out of Review/Done — those stay human actions.",
    "- New tasks start in Backlog; new epics start open.",
    "- Use a fresh, unique planId per proposal; re-POSTing the same planId is idempotent (no duplicate).",
    "",
    "In your chat reply, briefly tell the user what you proposed and that it is awaiting their review.",
  ].join("\n");
}
