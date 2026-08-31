import type { Prisma } from "@prisma/client";
import type { AgentVisibilityMode } from "@/lib/auth/roles";

type AgentContentViewer = {
  agentVisibility: AgentVisibilityMode;
};

/**
 * Central contract for agent-authored data.
 *
 * `masked` is an Admin presentation policy: the record remains available and
 * actor/text projectors replace identifying details. `hidden` is a Customer
 * data policy: the record must be removed before pagination, aggregation, or
 * serialization. Keeping those decisions explicit prevents a hidden viewer
 * from accidentally falling through the masking path.
 */
export function agentContentPolicy(viewer: AgentContentViewer) {
  const mode = viewer.agentVisibility;
  return {
    mode,
    excludeAgentRecords: mode === "hidden",
    maskAgentRecords: mode === "masked",
    // Body redaction is a superset safety net over exclusion: exclusion drops
    // agent-authored rows, but human-authored rows can still name an agent
    // ("@asdrubal", "Asdrubal rebased it"). Both masked Admins and hidden
    // Customers must never see real agent identities in free text, so redact
    // for both. The owner path (maskAgents=false) remains a no-op.
    redactAgentReferences: mode === "masked" || mode === "hidden",
  } as const;
}

export function hiddenCommentWhere(viewer: AgentContentViewer): Prisma.CommentWhereInput {
  if (!agentContentPolicy(viewer).excludeAgentRecords) return {};
  return {
    authorAgentSlug: null,
    isGenerated: false,
    user: { is: { kind: "human" } },
  };
}

export function hiddenAttachmentWhere(viewer: AgentContentViewer): Prisma.AttachmentWhereInput {
  if (!agentContentPolicy(viewer).excludeAgentRecords) return {};
  return { uploader: { is: { kind: "human" } } };
}

const INTERNAL_ACTIVITY_KINDS: Prisma.ActivityLogWhereInput[] = [
  { kind: { startsWith: "agent." } },
  { kind: { startsWith: "pm." } },
  { kind: { contains: ".action_plan" } },
  { kind: { contains: ".chat" } },
  { kind: { contains: ".comment" } },
  { kind: { contains: ".dispatch" } },
  { kind: { contains: ".stream" } },
  { kind: { contains: ".workflow" } },
  { kind: { contains: ".wake" } },
];

// Human-triggered rows can still be internal records when their payload names
// an agent or exposes workflow machinery. Hidden mode removes these kinds too;
// masked Admin feeds intentionally retain their existing behavior.
const HIDDEN_SENSITIVE_ACTIVITY_KINDS: Prisma.ActivityLogWhereInput[] = [
  { kind: { in: [
    "task.assign",
    "task.acting_manager",
    "task.reporter",
    "task.move",
    "epic.assign",
    "epic.acting_manager",
    "epic.deploy_reviewer",
    "epic.reporter",
  ] } },
  { kind: { startsWith: "workitem.proposal" } },
  { kind: { startsWith: "task.subtask" } },
  { kind: { startsWith: "task.branch" } },
  { kind: { startsWith: "task.commit_prefix" } },
  { kind: { startsWith: "task.blocker" } },
  { kind: { startsWith: "task.execution" } },
  { kind: { startsWith: "task.watchdog" } },
  { kind: { startsWith: "task.reset" } },
  { kind: { startsWith: "epic.completion" } },
  { kind: { startsWith: "epic.deploy" } },
];

/**
 * Query predicate for human-facing activity feeds. Masked Admins keep ordinary
 * in-scope agent activity but never receive raw PM/session plumbing. Hidden
 * Customers additionally receive only human-authored rows, excluding null-user
 * system traces as well as agent-authored workflow rows.
 */
export function visibleActivityRecordWhere(
  viewer: AgentContentViewer,
): Prisma.ActivityLogWhereInput {
  if (viewer.agentVisibility === "full") return {};

  const excludedKinds = agentContentPolicy(viewer).excludeAgentRecords
    ? [...INTERNAL_ACTIVITY_KINDS, ...HIDDEN_SENSITIVE_ACTIVITY_KINDS]
    : INTERNAL_ACTIVITY_KINDS;
  const clauses: Prisma.ActivityLogWhereInput[] = [
    { targetAgent: null },
    { NOT: excludedKinds },
  ];
  if (agentContentPolicy(viewer).excludeAgentRecords) {
    clauses.push({ user: { is: { kind: "human" } } });
  }
  return { AND: clauses };
}

/** Agent chat is an internal delivery channel and has no Customer row set. */
export function visibleAgentChatMessageWhere(
  viewer: AgentContentViewer,
): Prisma.AgentChatMessageWhereInput {
  return agentContentPolicy(viewer).excludeAgentRecords
    ? { id: { in: [] } }
    : {};
}
