// Work-item proposal apply core (Slice 3).
//
// commitProposal() takes a pending WorkItemProposal and the approving
// human's user id, re-validates the change-set against current state
// (as the AGENT — approval does not launder agent guardrails), then
// commits every operation in one transaction. It mirrors the canonical
// createTask / createEpic / moveTask shapes (rank, Backlog, statusChangedAt,
// activity rows).
//
// Attribution: the mutations themselves are logged as the AGENT
// (proposal.proposedByUserId) so the board feed reads "@agent created X",
// while the human's approval is recorded by proposal.appliedById + a
// single workitem.proposal.apply summary row. Re-validation failure
// aborts without writing anything.
//
// This module is intentionally auth-free (no next/auth, no revalidatePath)
// so it is unit-testable from a script; the "use server" wrappers in
// lib/work-items/actions.ts add auth + cache revalidation.

import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import { validateProposal } from "@/lib/work-items/proposal";

type RawOp = Record<string, unknown>;

export interface CommitCounts {
  epics: number;
  tasks: number;
  subtasks: number;
  updates: number;
  comments: number;
}

export interface CommitResult {
  ok: boolean;
  error?: string;
  projectSlug: string;
  agentSlug: string;
  counts: CommitCounts;
}

const ZERO: CommitCounts = { epics: 0, tasks: 0, subtasks: 0, updates: 0, comments: 0 };

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export async function commitProposal(
  proposalId: string,
  approverUserId: string,
): Promise<CommitResult> {
  const proposal = await db.workItemProposal.findUnique({
    where: { id: proposalId },
    select: {
      id: true,
      status: true,
      projectId: true,
      agentSlug: true,
      proposedByUserId: true,
      operations: true,
      project: { select: { slug: true, deletedAt: true } },
    },
  });
  if (!proposal) {
    return { ok: false, error: "Proposal not found", projectSlug: "", agentSlug: "", counts: ZERO };
  }
  const projectSlug = proposal.project.slug;
  const agentSlug = proposal.agentSlug;
  if (proposal.status !== "pending") {
    return { ok: false, error: `Proposal is already ${proposal.status}`, projectSlug, agentSlug, counts: ZERO };
  }
  if (proposal.project.deletedAt) {
    return { ok: false, error: "Project is in the bin", projectSlug, agentSlug, counts: ZERO };
  }

  let ops: RawOp[];
  try {
    const parsed = JSON.parse(proposal.operations) as unknown;
    ops = Array.isArray(parsed) ? (parsed as RawOp[]) : [];
  } catch {
    return { ok: false, error: "Stored operations are not valid JSON", projectSlug, agentSlug, counts: ZERO };
  }

  // Re-validate against current state, as the agent.
  const agentActor = { userId: proposal.proposedByUserId, agentSlug };
  const validation = await validateProposal(proposal.projectId, ops, agentActor);
  if (!validation.ok) {
    const firstErr = validation.results.find((r) => !r.ok)?.errors[0] ?? "validation failed";
    return { ok: false, error: `Re-validation failed: ${firstErr}`, projectSlug, agentSlug, counts: ZERO };
  }

  const principals = await listAssignablePrincipals();
  const idByUsername = new Map(principals.map((p) => [p.username, p.id]));
  const usernameById = new Map(principals.map((p) => [p.id, p.username]));

  // username|null|undefined -> id|null|undefined (undefined = field absent / leave unchanged)
  const resolvePrincipal = (value: unknown): string | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "string") return undefined;
    return idByUsername.get(value.replace(/^@/, "")) ?? null;
  };
  // For creates: absent/unknown -> null (unassigned).
  const createId = (value: unknown): string | null => {
    const r = resolvePrincipal(value);
    return r === undefined ? null : r;
  };

  const counts: CommitCounts = { ...ZERO };
  const agentId = proposal.proposedByUserId;
  const projectId = proposal.projectId;

  await db.$transaction(
    async (tx) => {
      const refToId = new Map<string, string>();
      const resolveRef = (value: unknown): string | null => {
        if (typeof value !== "string" || !value) return null;
        if (value.startsWith("tmp:")) return refToId.get(value) ?? null;
        return value;
      };

      const maxRank = await tx.task.aggregate({
        where: { projectId, status: "Backlog", deletedAt: null },
        _max: { rank: true },
      });
      let nextRank = (maxRank._max.rank ?? 0) + 1;

      // ---- creates, resolved in dependency waves (epic before its tasks,
      // parent before its sub-tasks; sub-tasks may nest) ----
      const depsOf = (op: RawOp): string[] => {
        const deps: string[] = [];
        if (op.op === "create_task" && typeof op.epic === "string" && op.epic.startsWith("tmp:")) deps.push(op.epic);
        if (op.op === "create_subtask" && typeof op.parent === "string" && op.parent.startsWith("tmp:")) deps.push(op.parent);
        return deps;
      };
      const pending = ops.filter(
        (op) => typeof op.op === "string" && (op.op as string).startsWith("create_"),
      );
      let guard = pending.length + 1;
      while (pending.length > 0 && guard-- > 0) {
        for (let k = pending.length - 1; k >= 0; k--) {
          const op = pending[k]!;
          if (!depsOf(op).every((d) => refToId.has(d))) continue;
          const ref = String(op.ref);

          if (op.op === "create_epic") {
            const epic = await tx.epic.create({
              data: {
                projectId,
                title: String(op.title),
                description: optionalText(op.description),
                status: "open",
                assigneeId: createId(op.assignee),
                actingManagerId: createId(op.actingManager),
              },
              select: { id: true, title: true },
            });
            refToId.set(ref, epic.id);
            counts.epics++;
            await tx.activityLog.create({
              data: {
                projectId,
                userId: agentId,
                kind: "epic.create",
                payload: JSON.stringify({ epicId: epic.id, title: epic.title, proposalId: proposal.id }),
              },
            });
          } else {
            const isSub = op.op === "create_subtask";
            const epicId = isSub ? null : op.epic !== undefined ? resolveRef(op.epic) : null;
            const parentTaskId = isSub ? resolveRef(op.parent) : null;
            const task = await tx.task.create({
              data: {
                projectId,
                epicId,
                parentTaskId,
                title: String(op.title),
                description: optionalText(op.description),
                status: "Backlog",
                rank: nextRank++,
                statusChangedAt: new Date(),
                assigneeId: createId(op.assignee),
                actingManagerId: createId(op.actingManager),
              },
              select: { id: true, title: true },
            });
            refToId.set(ref, task.id);
            if (isSub) counts.subtasks++;
            else counts.tasks++;
            let parentTitle: string | null = null;
            if (parentTaskId) {
              const parent = await tx.task.findUnique({ where: { id: parentTaskId }, select: { title: true } });
              parentTitle = parent?.title ?? null;
            }
            await tx.activityLog.create({
              data: {
                projectId,
                taskId: task.id,
                userId: agentId,
                kind: "task.create",
                payload: JSON.stringify({ title: task.title, epicId, parentTaskId, parentTitle, proposalId: proposal.id }),
              },
            });
          }
          pending.splice(k, 1);
        }
      }
      if (pending.length > 0) {
        throw new Error("unresolved temp-ref dependency cycle in proposal");
      }

      // ---- updates + comments ----
      for (const op of ops) {
        if (op.op === "update_epic") {
          const id = String(op.target);
          const epic = await tx.epic.findUnique({
            where: { id },
            select: {
              id: true, title: true, description: true, status: true,
              assigneeId: true, actingManagerId: true,
              assignee: { select: { username: true } },
              actingManager: { select: { username: true } },
            },
          });
          if (!epic) continue;
          const data: Record<string, unknown> = {};
          const logs: Array<Record<string, unknown>> = [];
          if (typeof op.title === "string" && op.title !== epic.title) data.title = op.title;
          if (op.description !== undefined) {
            const d = optionalText(op.description);
            if (d !== epic.description) data.description = d;
          }
          if (data.title !== undefined || data.description !== undefined) {
            logs.push({ kind: "epic.update", payload: { epicId: id, proposalId: proposal.id } });
          }
          const asg = resolvePrincipal(op.assignee);
          if (asg !== undefined && asg !== epic.assigneeId) {
            data.assigneeId = asg;
            logs.push({ kind: "epic.assign", payload: { epicId: id, from: epic.assignee?.username ?? null, to: asg ? usernameById.get(asg) ?? null : null, proposalId: proposal.id } });
          }
          const am = resolvePrincipal(op.actingManager);
          if (am !== undefined && am !== epic.actingManagerId) {
            data.actingManagerId = am;
            logs.push({ kind: "epic.acting_manager", payload: { epicId: id, from: epic.actingManager?.username ?? null, to: am ? usernameById.get(am) ?? null : null, proposalId: proposal.id } });
          }
          if (typeof op.status === "string" && op.status !== epic.status) {
            data.status = op.status;
            logs.push({ kind: "epic.status", payload: { epicId: id, from: epic.status, to: op.status, proposalId: proposal.id } });
          }
          if (Object.keys(data).length > 0) {
            await tx.epic.update({ where: { id }, data });
            for (const l of logs) {
              await tx.activityLog.create({ data: { projectId, userId: agentId, kind: l.kind as string, payload: JSON.stringify(l.payload) } });
            }
            counts.updates++;
          }
        } else if (op.op === "update_task") {
          const id = String(op.target);
          const task = await tx.task.findUnique({
            where: { id },
            select: {
              id: true, title: true, description: true, status: true, epicId: true, parentTaskId: true,
              assigneeId: true, actingManagerId: true,
              assignee: { select: { username: true } },
              actingManager: { select: { username: true } },
            },
          });
          if (!task) continue;
          const data: Record<string, unknown> = {};
          const logs: Array<Record<string, unknown>> = [];
          if (typeof op.title === "string" && op.title !== task.title) data.title = op.title;
          if (op.description !== undefined) {
            const d = optionalText(op.description);
            if (d !== task.description) data.description = d;
          }
          if (data.title !== undefined || data.description !== undefined) {
            logs.push({ kind: "task.update", payload: { taskId: id, proposalId: proposal.id } });
          }
          const asg = resolvePrincipal(op.assignee);
          if (asg !== undefined && asg !== task.assigneeId) {
            data.assigneeId = asg;
            logs.push({ kind: "task.assign", payload: { from: task.assignee?.username ?? null, to: asg ? usernameById.get(asg) ?? null : null, proposalId: proposal.id } });
          }
          const am = resolvePrincipal(op.actingManager);
          if (am !== undefined && am !== task.actingManagerId) {
            data.actingManagerId = am;
            logs.push({ kind: "task.acting_manager", payload: { from: task.actingManager?.username ?? null, to: am ? usernameById.get(am) ?? null : null, proposalId: proposal.id } });
          }
          if (op.epic !== undefined) {
            const epicId = resolveRef(op.epic);
            if (epicId !== task.epicId) {
              data.epicId = epicId;
              logs.push({ kind: "task.epic", payload: { from: task.epicId, to: epicId, proposalId: proposal.id } });
            }
          }
          if (op.parent !== undefined) {
            const parentTaskId = resolveRef(op.parent);
            if (parentTaskId !== task.parentTaskId) {
              data.parentTaskId = parentTaskId;
              logs.push({ kind: "task.update", payload: { taskId: id, parentTaskId, proposalId: proposal.id } });
            }
          }
          if (typeof op.status === "string" && op.status !== task.status) {
            const rankAgg = await tx.task.aggregate({
              where: { projectId, status: op.status, deletedAt: null },
              _max: { rank: true },
            });
            data.status = op.status;
            data.rank = (rankAgg._max.rank ?? 0) + 1;
            data.statusChangedAt = new Date();
            logs.push({ kind: "task.move", payload: { from: task.status, to: op.status, proposalId: proposal.id } });
          }
          if (Object.keys(data).length > 0) {
            await tx.task.update({ where: { id }, data });
            for (const l of logs) {
              await tx.activityLog.create({ data: { projectId, taskId: id, userId: agentId, kind: l.kind as string, payload: JSON.stringify(l.payload) } });
            }
            counts.updates++;
          }
        } else if (op.op === "comment_task") {
          const id = String(op.target);
          const body = typeof op.body === "string" ? op.body : "";
          if (!body.trim()) continue;
          const comment = await tx.comment.create({
            data: { taskId: id, userId: agentId, body },
            select: { id: true },
          });
          await tx.activityLog.create({
            data: {
              projectId,
              taskId: id,
              userId: agentId,
              kind: "task.comment",
              payload: JSON.stringify({ commentId: comment.id, proposalId: proposal.id }),
            },
          });
          counts.comments++;
        }
      }

      await tx.workItemProposal.update({
        where: { id: proposal.id },
        data: { status: "applied", appliedById: approverUserId, appliedAt: new Date() },
      });
      await tx.activityLog.create({
        data: {
          projectId,
          userId: approverUserId,
          kind: "workitem.proposal.apply",
          targetAgent: agentSlug,
          payload: JSON.stringify({ proposalId: proposal.id, agentSlug, opCount: ops.length }),
        },
      });
    },
    { timeout: 20000, maxWait: 10000 },
  );

  return { ok: true, projectSlug, agentSlug, counts };
}
