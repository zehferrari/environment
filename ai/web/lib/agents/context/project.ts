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
const MAX_EPIC_DESCRIPTION = 6000;
const MAX_TASK_DESCRIPTION = 1600;

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
      select: { id: true, title: true, status: true, description: true },
    }),
    db.task.findMany({
      where: { projectId, deletedAt: null, status: { not: "Done" } },
      orderBy: [{ status: "asc" }, { rank: "asc" }],
      take: MAX_TASKS,
      select: {
        id: true,
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
  else for (const e of epics) {
    lines.push(`- [${e.status}] ${e.title} (id: ${e.id})`);
    if (e.description?.trim()) {
      lines.push(
        `  Description for epic ${e.id}:`,
        `<<<EPIC_DESCRIPTION_${e.id}`,
        clip(e.description, MAX_EPIC_DESCRIPTION),
        `EPIC_DESCRIPTION_${e.id}>>>`,
      );
    } else {
      lines.push(`  Description for epic ${e.id}: (empty)`);
    }
  }

  lines.push("", `EXISTING OPEN TASKS (${tasks.length}; excludes Done):`);
  if (tasks.length === 0) lines.push("(none)");
  else for (const t of tasks) {
    const rel = [
      t.epicId ? `epic: ${t.epicId}` : "",
      t.parentTaskId ? `parent: ${t.parentTaskId}` : "",
    ].filter(Boolean).join(", ");
    lines.push(`- [${t.status}] ${t.title} (id: ${t.id}${rel ? `, ${rel}` : ""})`);
    if (t.description?.trim()) {
      lines.push(
        `  Description for task ${t.id}:`,
        `<<<TASK_DESCRIPTION_${t.id}`,
        clip(t.description, MAX_TASK_DESCRIPTION),
        `TASK_DESCRIPTION_${t.id}>>>`,
      );
    }
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
    "A human-authored message in this project-scoped chat gives you a one-shot capability to PROPOSE work-item changes.",
    "Use it only when the current human message directly asks you to create, update, reorganize, comment on, or otherwise change project work items. If the message is only a question, discussion, or status check, do not submit a proposal.",
    "Use the PROJECT ENVIRONMENT block as the source of truth. Do not try to fetch PM's local web UI or internal API; the proposal endpoint below is the only project-write endpoint you should call from this turn.",
    "Nothing changes on the board until the user reviews and approves your proposal, so make the breakdown clear and well structured when you do propose.",
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
    "- update_epic    { target, title?, description?, assignee?, actingManager?, status? }   (status: Backlog|Open|Done|Archive)",
    "- update_task    { target, title?, description?, assignee?, actingManager?, epic?, parent?, status? }",
    "- comment_task   { target, body }",
    "",
    "REFERENCES:",
    '- New items you create take a "ref" that MUST start with "tmp:" (e.g. "tmp:epic1"). Reference them from later ops (epic / parent) by that ref.',
    "- To touch existing items, use their real id from the PROJECT ENVIRONMENT block above (target / epic / parent).",
    "- assignee / actingManager are usernames from the ASSIGNABLE PRINCIPALS list, or null to leave unset.",
    "",
    "RULES (your proposal is validated against these; violations are flagged for the user):",
    "- You may propose changes anywhere in the project when the current human message explicitly asks for them.",
    "- Keep requested assignee / actingManager values exactly as the human asked; otherwise leave them null.",
    "- Nothing is applied until the human reviews and approves the proposal.",
    "- New tasks and epics start in Backlog.",
    "- Use a fresh, unique planId per proposal; re-POSTing the same planId is idempotent (no duplicate).",
    "",
    "In your chat reply, briefly tell the user what you proposed and that it is awaiting their review.",
  ].join("\n");
}
