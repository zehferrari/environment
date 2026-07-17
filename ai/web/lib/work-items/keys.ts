import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type KeyStore = Pick<Prisma.TransactionClient, "project">;

export function normalizeWorkItemKeyPrefix(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

export function isValidWorkItemKeyPrefix(value: string): boolean {
  return normalizeWorkItemKeyPrefix(value) === value.trim().toUpperCase();
}

export function defaultWorkItemKeyPrefix(project: { slug: string; name: string }): string {
  const source = project.slug || project.name;
  const tokens = source.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
  if (tokens.length === 0) return "PM";

  const candidate = tokens.length === 1
    ? tokens[0]!.slice(0, 3)
    : tokens.map((token) => token[0]).join("").slice(0, 4);

  const prefix = candidate.toUpperCase();
  return /^[A-Z][A-Z0-9]{1,9}$/.test(prefix) ? prefix : "PM";
}

export function effectiveCommitPrefix(args: {
  commitPrefix?: string | null;
  workItemKey?: string | null;
}) {
  const explicit = args.commitPrefix?.trim();
  return explicit || args.workItemKey || null;
}

export function effectiveTaskCommitPrefix(task: {
  workItemKey: string | null;
  commitPrefix: string | null;
  epic?: { commitPrefix: string | null } | null;
}) {
  const taskPrefix = task.commitPrefix?.trim();
  if (taskPrefix) return taskPrefix;

  const epicPrefix = task.epic?.commitPrefix?.trim();
  return epicPrefix || task.workItemKey || null;
}

async function availableProjectPrefix(
  projectId: string,
  basePrefix: string,
  store: KeyStore,
) {
  let prefix = basePrefix;
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const existing = await store.project.findUnique({
      where: { workItemKeyPrefix: prefix },
      select: { id: true },
    });
    if (!existing || existing.id === projectId) return prefix;
    const suffixText = String(suffix + 1);
    prefix = `${basePrefix.slice(0, Math.max(1, 10 - suffixText.length))}${suffixText}`;
  }
  throw new Error(`No available project key prefix for ${basePrefix}`);
}

export async function allocateWorkItemKey(
  projectId: string,
  store: KeyStore = db,
): Promise<string> {
  const project = await store.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      slug: true,
      name: true,
      workItemKeyPrefix: true,
      nextWorkItemNumber: true,
    },
  });
  if (!project) throw new Error("Project not found");

  const existingPrefix = normalizeWorkItemKeyPrefix(project.workItemKeyPrefix);
  const prefix = existingPrefix ??
    (await availableProjectPrefix(project.id, defaultWorkItemKeyPrefix(project), store));
  const nextNumber = Math.max(1, project.nextWorkItemNumber ?? 1);
  const data: Prisma.ProjectUpdateInput = {
    nextWorkItemNumber: nextNumber + 1,
  };
  if (project.workItemKeyPrefix !== prefix) data.workItemKeyPrefix = prefix;
  await store.project.update({ where: { id: project.id }, data });
  return `${prefix}-${nextNumber}`;
}
