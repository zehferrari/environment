import type { PrismaClient } from "@prisma/client";
import { hasImmutableOwnerCapability } from "@/lib/auth/roles";
import { db } from "@/lib/db";

// Deleting an account should never erase or detach work history. Project
// membership and credentials are deliberately absent: both are safe to revoke
// with the account. Every item below represents a workflow, audit, or
// conversation relationship that must be retained instead.
const REMOVAL_BLOCKERS = [
  { key: "assignedTasks", label: "assigned tasks" },
  { key: "actingManagerOf", label: "task acting-manager roles" },
  { key: "reportedTasks", label: "reported tasks" },
  { key: "approvedTasks", label: "task approvals" },
  { key: "archivedTasks", label: "task archive actions" },
  { key: "deletedTasks", label: "task deletion actions" },
  { key: "actingManagerOfEpic", label: "epic acting-manager roles" },
  { key: "deployReviewerOfEpics", label: "epic deploy-reviewer roles" },
  { key: "reportedEpics", label: "reported epics" },
  { key: "approvedEpics", label: "epic approvals" },
  { key: "archivedEpics", label: "epic archive actions" },
  { key: "deletedEpics", label: "epic deletion actions" },
  { key: "epicWorkerAssignments", label: "epic worker-pool assignments" },
  { key: "defaultAssigneeForProjects", label: "project default-assignee settings" },
  { key: "defaultReviewerForProjects", label: "project default-reviewer settings" },
  { key: "managerAssignableProjects", label: "project manager-pool assignments" },
  { key: "comments", label: "comments" },
  { key: "deletedComments", label: "deleted comments" },
  { key: "activity", label: "activity log entries" },
  { key: "uploadedAttachments", label: "uploaded attachments" },
  { key: "agentChatMessages", label: "agent chat messages" },
  { key: "deletedAgentChatMessages", label: "agent chat deletion actions" },
  { key: "archivedAgentChatRooms", label: "agent chat archives" },
  { key: "deletedAgentChatRoomArchives", label: "agent chat archive deletion actions" },
  { key: "directAgentChatMessages", label: "direct agent messages" },
  { key: "deletedDirectAgentChatMessages", label: "direct message deletion actions" },
  { key: "archivedDirectAgentChats", label: "direct chat archives" },
  { key: "deletedDirectAgentChatArchives", label: "direct chat archive deletion actions" },
  { key: "workItemProposalsProposed", label: "work-item proposals" },
  { key: "workItemProposalsApplied", label: "work-item proposal approvals" },
  { key: "workItemProposalsRejected", label: "work-item proposal rejections" },
  { key: "archivedWorkspaces", label: "workspace archive actions" },
  { key: "deletedProjects", label: "project deletion actions" },
] as const;

type RemovalBlockerKey =
  | (typeof REMOVAL_BLOCKERS)[number]["key"]
  | "descriptionDrafts"
  | "deploymentReports"
  | "deploymentApprovals"
  | "pmEventDeliveries"
  | "linkedAgent";

export type UserRemovalBlocker = {
  key: RemovalBlockerKey;
  label: string;
  count: number;
};

export type HumanUserRemovalStatus = {
  id: string;
  username: string;
  exists: boolean;
  isHuman: boolean;
  isOwner: boolean;
  removable: boolean;
  blockers: UserRemovalBlocker[];
};

type UserRemovalDb = Pick<
  PrismaClient,
  "user" | "descriptionDraft" | "deploymentPullRequest" | "pmEventDelivery"
>;

const removalCountSelect = {
  assignedTasks: true,
  actingManagerOf: true,
  reportedTasks: true,
  approvedTasks: true,
  archivedTasks: true,
  deletedTasks: true,
  actingManagerOfEpic: true,
  deployReviewerOfEpics: true,
  reportedEpics: true,
  approvedEpics: true,
  archivedEpics: true,
  deletedEpics: true,
  epicWorkerAssignments: true,
  defaultAssigneeForProjects: true,
  defaultReviewerForProjects: true,
  managerAssignableProjects: true,
  comments: true,
  deletedComments: true,
  activity: true,
  uploadedAttachments: true,
  agentChatMessages: true,
  deletedAgentChatMessages: true,
  archivedAgentChatRooms: true,
  deletedAgentChatRoomArchives: true,
  directAgentChatMessages: true,
  deletedDirectAgentChatMessages: true,
  archivedDirectAgentChats: true,
  deletedDirectAgentChatArchives: true,
  workItemProposalsProposed: true,
  workItemProposalsApplied: true,
  workItemProposalsRejected: true,
  archivedWorkspaces: true,
  deletedProjects: true,
} as const;

/**
 * Report whether a human account can be physically removed without losing or
 * detaching any history. The optional client lets the delete action run the
 * same check inside its transaction, avoiding a check/delete race.
 */
export async function getHumanUserRemovalStatus(
  userId: string,
  client: UserRemovalDb = db,
): Promise<HumanUserRemovalStatus> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      kind: true,
      isOwner: true,
      agentId: true,
      _count: { select: removalCountSelect },
    },
  });

  if (!user) {
    return {
      id: userId,
      username: "",
      exists: false,
      isHuman: false,
      isOwner: false,
      removable: false,
      blockers: [],
    };
  }

  const blockers: UserRemovalBlocker[] = REMOVAL_BLOCKERS.flatMap(({ key, label }) => {
    const count = user._count[key];
    return count > 0 ? [{ key, label, count }] : [];
  });

  if (user.agentId) {
    blockers.push({ key: "linkedAgent", label: "linked agent account", count: 1 });
  }

  // These historic identity fields are intentionally denormalized, so they
  // have no User FK to protect them during deletion. They still count as
  // account activity and must retain their actor/reporter attribution.
  const [
    descriptionDrafts,
    deploymentReports,
    deploymentApprovals,
    pmEventDeliveries,
  ] = await Promise.all([
    client.descriptionDraft.count({ where: { requesterUserId: user.id } }),
    client.deploymentPullRequest.count({ where: { reporterUserId: user.id } }),
    client.deploymentPullRequest.count({ where: { localChangeApprovedById: user.id } }),
    client.pmEventDelivery.count({ where: { actorId: user.id } }),
  ]);
  if (descriptionDrafts > 0) {
    blockers.push({ key: "descriptionDrafts", label: "pending description requests", count: descriptionDrafts });
  }
  if (deploymentReports > 0) {
    blockers.push({ key: "deploymentReports", label: "deployment reports", count: deploymentReports });
  }
  if (deploymentApprovals > 0) {
    blockers.push({ key: "deploymentApprovals", label: "deployment review approvals", count: deploymentApprovals });
  }
  if (pmEventDeliveries > 0) {
    blockers.push({ key: "pmEventDeliveries", label: "PM event delivery records", count: pmEventDeliveries });
  }

  return {
    id: user.id,
    username: user.username,
    exists: true,
    isHuman: user.kind === "human",
    isOwner: user.isOwner,
    removable: user.kind === "human" && !hasImmutableOwnerCapability(user) && blockers.length === 0,
    blockers,
  };
}
