import { db } from "@/lib/db";

export type ProposalRelatedItem = {
  id: string;
  kind: "Task" | "Epic";
  label: string;
  status: string;
  archived: boolean;
  href?: string;
};

type ProposalContextInput = {
  projectId: string;
  operations: string;
  grantMessageId: string | null;
};

// Owner review surfaces only. Resolve current records on each page request,
// outside the cached proposal payload, so old proposals show today's state.
export async function withProposalReviewContext<T extends ProposalContextInput>(proposals: T[]) {
  if (!proposals.length) return [] as Array<T & { relatedItems: ProposalRelatedItem[] }>;
  const messages = await db.agentChatMessage.findMany({
    where: { id: { in: proposals.flatMap(p => p.grantMessageId ? [p.grantMessageId] : []) } },
    select: { id: true, taskId: true, epicId: true },
  });
  const sources = new Map(messages.map(message => [message.id, message]));
  const refs = proposals.map(proposal => {
    const items = new Map<string, { id: string; kind: "Task" | "Epic"; projectId: string }>();
    const add = (kind: "Task" | "Epic", id: unknown) => {
      if (typeof id !== "string" || !id || id.startsWith("tmp:")) return;
      items.set(`${kind}:${id}`, { id, kind, projectId: proposal.projectId });
    };
    const source = proposal.grantMessageId ? sources.get(proposal.grantMessageId) : null;
    add("Task", source?.taskId);
    add("Epic", source?.epicId);
    let operations: unknown;
    try { operations = JSON.parse(proposal.operations); } catch { operations = []; }
    if (Array.isArray(operations)) for (const op of operations) {
      if (!op || typeof op !== "object") continue;
      if (op.op === "update_epic") add("Epic", op.target);
      if (op.op === "update_task" || op.op === "comment_task") add("Task", op.target);
      if (op.op === "create_task" || op.op === "update_task") {
        add("Epic", op.epic);
        add("Task", op.blockedBy);
      }
      if (op.op === "create_subtask" || op.op === "update_task") add("Task", op.parent);
    }
    return [...items.values()];
  });
  const whereFor = (kind: "Task" | "Epic") => ({ OR: refs.flat().filter(ref => ref.kind === kind).map(({ id, projectId }) => ({ id, projectId })) });
  const select = { id: true, projectId: true, title: true, workItemKey: true, status: true,
    archivedAt: true, deletedAt: true, project: { select: { slug: true } } } as const;
  const tasks = await db.task.findMany({ where: whereFor("Task"), select: { ...select, epicId: true } });
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  for (const items of refs) for (const ref of [...items]) {
    const task = ref.kind === "Task" ? tasksById.get(ref.id) : null;
    if (task?.epicId && task.projectId === ref.projectId && !task.deletedAt
      && !items.some(item => item.kind === "Epic" && item.id === task.epicId)) {
      items.push({ id: task.epicId, kind: "Epic", projectId: ref.projectId });
    }
  }
  const epics = await db.epic.findMany({ where: whereFor("Epic"), select });
  const records = new Map([
    ...tasks.map(item => [`Task:${item.projectId}:${item.id}`, item] as const),
    ...epics.map(item => [`Epic:${item.projectId}:${item.id}`, item] as const),
  ]);
  return proposals.map((proposal, index) => ({
    ...proposal,
    relatedItems: refs[index].map(({ id, kind, projectId }): ProposalRelatedItem => {
      const item = records.get(`${kind}:${projectId}:${id}`);
      if (!item || item.deletedAt) return {
        id, kind, label: item?.workItemKey || id,
        status: item ? "Deleted" : "Unavailable", archived: false,
      };
      return { id, kind, label: `${item.workItemKey ? `${item.workItemKey} · ` : ""}${item.title}`,
        status: item.status, archived: Boolean(item.archivedAt),
        href: `/projects/${item.project.slug}/${kind === "Task" ? "tasks" : "epics"}/${id}` };
    }),
  }));
}
