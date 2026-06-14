import { db } from "@/lib/db";

/**
 * What removing an agent actually touches, so the UI can show an honest
 * blast-radius summary before the destructive confirm and the remove route can
 * audit-log it afterwards.
 *
 * Removal hard-deletes the Agent registration row (the dashboard card) and lets
 * the root helper tear down the OS/registry side. The agent's PM *login* is
 * deactivated and unlinked rather than deleted, because several tables hold a
 * required, non-cascading FK to the user (chat messages, work proposals) — a
 * hard user delete would either fail or destroy shared history. So PM history
 * is preserved, attributed to the now-deactivated account.
 */
export type AgentDeletionSummary = {
  slug: string;
  name: string;
  role: string;
  /** Resources removed entirely. */
  removed: string[];
  /** The PM login account, disabled but kept (null if no user row). */
  account: { username: string; note: string } | null;
  /** PM records kept and still attributed to the deactivated account. */
  preserved: { label: string; count: number }[];
};

export async function summarizeAgentDeletion(slug: string): Promise<AgentDeletionSummary> {
  const agent = await db.agent.findUnique({
    where: { slug },
    include: {
      user: {
        select: {
          username: true,
          _count: {
            select: {
              assignedTasks: true,
              reportedTasks: true,
              activity: true,
              comments: true,
              agentChatMessages: true,
              directAgentChatMessages: true,
              workItemProposalsProposed: true,
              projectMembers: true,
            },
          },
        },
      },
    },
  });

  const removed = [
    "OpenClaw registry entry",
    "Linux user, home directory & workspace",
    "Samba credential & sudoers grant",
    "Agent runtime directory & gateway port",
    "PM agent registration (dashboard card)",
  ];

  if (!agent) {
    return { slug, name: slug, role: "unknown", removed, account: null, preserved: [] };
  }

  const c = agent.user?._count;
  const preserved: { label: string; count: number }[] = c
    ? [
        { label: "Assigned tasks", count: c.assignedTasks },
        { label: "Reported tasks", count: c.reportedTasks },
        { label: "Activity log entries", count: c.activity },
        { label: "Comments", count: c.comments },
        { label: "Room chat messages", count: c.agentChatMessages },
        { label: "Direct messages", count: c.directAgentChatMessages },
        { label: "Work proposals", count: c.workItemProposalsProposed },
        { label: "Project memberships", count: c.projectMembers },
      ]
    : [];

  return {
    slug,
    name: agent.name,
    role: agent.role,
    removed,
    account: agent.user
      ? { username: agent.user.username, note: "deactivated & unlinked — can no longer sign in" }
      : null,
    preserved,
  };
}
