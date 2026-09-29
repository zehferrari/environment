import { withProposalReviewContext } from "@/lib/work-items/proposal-review-context";
import Link from "next/link";
import ProposalReview from "@/app/(app)/agents/[agent]/chat/proposal-review";
import { requireOwner } from "@/lib/auth/permissions";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function ProposalsPage() {
  await requireOwner();
  const proposals = await db.workItemProposal.findMany({
    where: { status: "pending", project: { deletedAt: null } },
    orderBy: { createdAt: "desc" },
    include: { project: { select: { name: true, slug: true } } },
  });
  const messages = await db.agentChatMessage.findMany({
    where: { id: { in: proposals.flatMap(p => p.grantMessageId ? [p.grantMessageId] : []) } },
    select: { id: true, taskId: true, epicId: true },
  });
  const sources = new Map(messages.map(m => [m.id, m]));
  const reviewProposals = await withProposalReviewContext(proposals);
  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-title font-semibold">Proposals</h1>
        <p className="mt-2 text-body text-text-muted">Review changes agents have suggested across your projects. Preview each change, then Apply or Reject it.</p>
      </header>
      {proposals.length ? <ProposalReview proposals={reviewProposals.map(p => {
        const source = p.grantMessageId ? sources.get(p.grantMessageId) : null;
        const projectPath = `/projects/${p.project.slug}`;
        return { ...p, createdAt: p.createdAt.toISOString(), projectName: p.project.name,
          sourceUrl: source?.taskId ? `${projectPath}/tasks/${source.taskId}`
            : source?.epicId ? `${projectPath}/epics/${source.epicId}` : `/agents/${p.agentSlug}/chat`,
        };
      })} /> : <p className="rounded-panel border border-line bg-panel p-card text-text-muted">No proposals are awaiting your review.</p>}
      <Link href="/workspaces" className="text-caption text-accent hover:underline">Back to workspaces</Link>
    </section>
  );
}
