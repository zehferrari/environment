import { db } from "@/lib/db";
import {
  defaultWorkItemKeyPrefix,
  normalizeWorkItemKeyPrefix,
} from "@/lib/work-items/keys";

function numberFromKey(key: string | null, prefix: string) {
  if (!key) return null;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = key.match(new RegExp(`^${escaped}-(\\d+)$`));
  if (!match) return null;
  return Number(match[1]);
}

function uniquePrefix(basePrefix: string, used: Set<string>) {
  if (!used.has(basePrefix)) return basePrefix;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const suffixText = String(suffix);
    const candidate = `${basePrefix.slice(0, Math.max(1, 10 - suffixText.length))}${suffixText}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`No available project key prefix for ${basePrefix}`);
}

async function main() {
  const projects = await db.project.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      slug: true,
      name: true,
      workItemKeyPrefix: true,
      nextWorkItemNumber: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const usedPrefixes = new Set(
    projects
      .map((project) => normalizeWorkItemKeyPrefix(project.workItemKeyPrefix))
      .filter((prefix): prefix is string => Boolean(prefix)),
  );

  for (const project of projects) {
    const normalizedExisting = normalizeWorkItemKeyPrefix(project.workItemKeyPrefix);
    const prefix = normalizedExisting ??
      uniquePrefix(defaultWorkItemKeyPrefix(project), usedPrefixes);
    usedPrefixes.add(prefix);

    await db.$transaction(async (tx) => {
      const [epics, tasks] = await Promise.all([
        tx.epic.findMany({
          where: { projectId: project.id },
          select: { id: true, workItemKey: true, createdAt: true },
        }),
        tx.task.findMany({
          where: { projectId: project.id },
          select: { id: true, workItemKey: true, createdAt: true },
        }),
      ]);
      const items = [
        ...epics.map((epic) => ({ ...epic, kind: "epic" as const })),
        ...tasks.map((task) => ({ ...task, kind: "task" as const })),
      ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      let maxExisting = 0;
      for (const item of items) {
        const n = numberFromKey(item.workItemKey, prefix);
        if (n && n > maxExisting) maxExisting = n;
      }

      let next = Math.max(1, maxExisting + 1);
      for (const item of items) {
        if (item.workItemKey) continue;
        const workItemKey = `${prefix}-${next}`;
        next += 1;
        if (item.kind === "epic") {
          await tx.epic.update({ where: { id: item.id }, data: { workItemKey } });
        } else {
          await tx.task.update({ where: { id: item.id }, data: { workItemKey } });
        }
      }

      await tx.project.update({
        where: { id: project.id },
        data: {
          workItemKeyPrefix: prefix,
          nextWorkItemNumber: Math.max(next, project.nextWorkItemNumber ?? 1),
        },
      });
    });
  }

  console.log(`Backfilled work-item keys for ${projects.length} project(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
