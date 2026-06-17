import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { workspaceLogoPublicUrl } from "@/lib/workspaces/storage";

const WORKSPACE_TYPES = new Set(["internal", "client", "personal", "other"]);
const slugPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function normalizeWorkspaceSlug(value: unknown): string {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!slug || slug.length > 80 || !slugPattern.test(slug)) {
    throw new Error("Workspace slug must be lowercase letters/numbers separated by dot, underscore, or hyphen.");
  }
  return slug;
}

export function normalizeWorkspaceType(value: unknown): string {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "internal";
  if (!WORKSPACE_TYPES.has(type)) throw new Error("Workspace type is invalid.");
  return type;
}

export function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export type WorkspacePayload = {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  type?: unknown;
  projectIds?: unknown;
  agentIds?: unknown;
  defaultGitUserName?: unknown;
  defaultGitUserEmail?: unknown;
  doneTtlDays?: unknown;
  deploymentProvider?: unknown;
  deploymentProductionBranch?: unknown;
  deploymentPrTargetBranch?: unknown;
  deploymentMode?: unknown;
  deploymentOnMerge?: unknown;
  deploymentPipelineName?: unknown;
  deploymentHost?: unknown;
  deploymentEnvironment?: unknown;
  deploymentBitbucketWorkspace?: unknown;
  deploymentBitbucketRepoSlug?: unknown;
  integrationDefaults?: unknown;
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))];
}

function intOrNull(value: unknown, min: number, max: number): number | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function jsonObjectTextOrNull(value: unknown): string | null {
  const raw = trimOrNull(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return JSON.stringify(parsed, null, 2);
  } catch {
    throw new Error("Integration defaults must be a JSON object.");
  }
}

function workspaceDefaultsData(payload: WorkspacePayload): Record<string, string | number | null> {
  const data: Record<string, string | number | null> = {};
  if (payload.defaultGitUserName !== undefined) data.defaultGitUserName = trimOrNull(payload.defaultGitUserName);
  if (payload.defaultGitUserEmail !== undefined) data.defaultGitUserEmail = trimOrNull(payload.defaultGitUserEmail);
  if (payload.doneTtlDays !== undefined) data.doneTtlDays = intOrNull(payload.doneTtlDays, 1, 365);
  if (payload.deploymentProvider !== undefined) data.deploymentProvider = trimOrNull(payload.deploymentProvider);
  if (payload.deploymentProductionBranch !== undefined) data.deploymentProductionBranch = trimOrNull(payload.deploymentProductionBranch);
  if (payload.deploymentPrTargetBranch !== undefined) data.deploymentPrTargetBranch = trimOrNull(payload.deploymentPrTargetBranch);
  if (payload.deploymentMode !== undefined) data.deploymentMode = trimOrNull(payload.deploymentMode);
  if (payload.deploymentOnMerge !== undefined) data.deploymentOnMerge = trimOrNull(payload.deploymentOnMerge);
  if (payload.deploymentPipelineName !== undefined) data.deploymentPipelineName = trimOrNull(payload.deploymentPipelineName);
  if (payload.deploymentHost !== undefined) data.deploymentHost = trimOrNull(payload.deploymentHost);
  if (payload.deploymentEnvironment !== undefined) data.deploymentEnvironment = trimOrNull(payload.deploymentEnvironment);
  if (payload.deploymentBitbucketWorkspace !== undefined) data.deploymentBitbucketWorkspace = trimOrNull(payload.deploymentBitbucketWorkspace);
  if (payload.deploymentBitbucketRepoSlug !== undefined) data.deploymentBitbucketRepoSlug = trimOrNull(payload.deploymentBitbucketRepoSlug);
  if (payload.integrationDefaults !== undefined) data.integrationDefaults = jsonObjectTextOrNull(payload.integrationDefaults);
  return data;
}

export async function validateProjectIds(projectIds: string[]) {
  if (projectIds.length === 0) return [];
  const rows = await db.project.findMany({
    where: { id: { in: projectIds }, deletedAt: null },
    select: { id: true },
  });
  const valid = new Set(rows.map((r) => r.id));
  const missing = projectIds.filter((id) => !valid.has(id));
  if (missing.length > 0) throw new Error("Workspace projects must reference existing active projects.");
  return projectIds;
}

export async function validateAgentIds(agentIds: string[]) {
  if (agentIds.length === 0) return [];
  const rows = await db.agent.findMany({
    where: { id: { in: agentIds }, role: "coding", deactivatedAt: null, user: { is: { status: "active" } } },
    select: { id: true },
  });
  const valid = new Set(rows.map((r) => r.id));
  const missing = agentIds.filter((id) => !valid.has(id));
  if (missing.length > 0) throw new Error("Workspace agent pool can only include active coding agents.");
  return agentIds;
}

const workspaceInclude = {
  projects: { include: { project: { select: { id: true, slug: true, name: true, archivedAt: true, deletedAt: true } } }, orderBy: { createdAt: "asc" as const } },
  agentPool: { include: { agent: { select: { id: true, slug: true, name: true, role: true, deactivatedAt: true } } }, orderBy: { createdAt: "asc" as const } },
};

type WorkspaceWithRelations = Prisma.WorkspaceGetPayload<{ include: typeof workspaceInclude }>;

export function serializeWorkspace(workspace: WorkspaceWithRelations) {
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    description: workspace.description,
    type: workspace.type,
    archivedAt: workspace.archivedAt?.toISOString() ?? null,
    logo: workspace.logoPath
      ? {
          url: workspaceLogoPublicUrl(workspace.slug, workspace.logoUpdatedAt),
          mimeType: workspace.logoMimeType,
          sizeBytes: workspace.logoSizeBytes,
          updatedAt: workspace.logoUpdatedAt?.toISOString() ?? null,
        }
      : null,
    projects: workspace.projects.map(({ project }) => ({
      id: project.id,
      slug: project.slug,
      name: project.name,
      archivedAt: project.archivedAt?.toISOString() ?? null,
      deletedAt: project.deletedAt?.toISOString() ?? null,
    })),
    agentPool: workspace.agentPool.map(({ agent }) => ({
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      role: agent.role,
      deactivatedAt: agent.deactivatedAt?.toISOString() ?? null,
    })),
    defaults: {
      defaultGitUserName: workspace.defaultGitUserName,
      defaultGitUserEmail: workspace.defaultGitUserEmail,
      doneTtlDays: workspace.doneTtlDays,
      deploymentProvider: workspace.deploymentProvider,
      deploymentProductionBranch: workspace.deploymentProductionBranch,
      deploymentPrTargetBranch: workspace.deploymentPrTargetBranch,
      deploymentMode: workspace.deploymentMode,
      deploymentOnMerge: workspace.deploymentOnMerge,
      deploymentPipelineName: workspace.deploymentPipelineName,
      deploymentHost: workspace.deploymentHost,
      deploymentEnvironment: workspace.deploymentEnvironment,
      deploymentBitbucketWorkspace: workspace.deploymentBitbucketWorkspace,
      deploymentBitbucketRepoSlug: workspace.deploymentBitbucketRepoSlug,
      integrationDefaults: workspace.integrationDefaults,
    },
    createdAt: workspace.createdAt.toISOString(),
    updatedAt: workspace.updatedAt.toISOString(),
  };
}

export async function selectableWorkspaceAgents() {
  return db.agent.findMany({
    where: { role: "coding", deactivatedAt: null, user: { is: { status: "active" } } },
    select: { id: true, slug: true, name: true },
    orderBy: { slug: "asc" },
  });
}

export async function listWorkspaces(includeArchived = false) {
  const rows = await db.workspace.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    include: workspaceInclude,
    orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
  });
  return rows.map(serializeWorkspace);
}

export async function getWorkspaceBySlug(slug: string) {
  return db.workspace.findUnique({ where: { slug }, include: workspaceInclude });
}

export async function createWorkspace(payload: WorkspacePayload) {
  const name = trimOrNull(payload.name);
  if (!name) throw new Error("Workspace name is required.");
  const slug = normalizeWorkspaceSlug(payload.slug ?? name);
  const type = normalizeWorkspaceType(payload.type);
  const projectIds = await validateProjectIds(stringArray(payload.projectIds));
  const agentIds = await validateAgentIds(stringArray(payload.agentIds));

  const row = await db.workspace.create({
    data: {
      name,
      slug,
      description: trimOrNull(payload.description),
      type,
      projects: { create: projectIds.map((projectId) => ({ projectId })) },
      agentPool: { create: agentIds.map((agentId) => ({ agentId })) },
      ...workspaceDefaultsData(payload),
    },
    include: workspaceInclude,
  });
  return serializeWorkspace(row);
}

export async function updateWorkspace(slug: string, payload: WorkspacePayload) {
  const existing = await db.workspace.findUnique({ where: { slug }, select: { id: true } });
  if (!existing) return null;
  const data: Prisma.WorkspaceUpdateInput = {};
  if (payload.name !== undefined) {
    const name = trimOrNull(payload.name);
    if (!name) throw new Error("Workspace name is required.");
    data.name = name;
  }
  if (payload.slug !== undefined) data.slug = normalizeWorkspaceSlug(payload.slug);
  if (payload.description !== undefined) data.description = trimOrNull(payload.description);
  if (payload.type !== undefined) data.type = normalizeWorkspaceType(payload.type);
  Object.assign(data, workspaceDefaultsData(payload));
  const projectIds = payload.projectIds === undefined ? null : await validateProjectIds(stringArray(payload.projectIds));
  const agentIds = payload.agentIds === undefined ? null : await validateAgentIds(stringArray(payload.agentIds));

  const row = await db.$transaction(async (tx) => {
    if (projectIds) {
      await tx.workspaceProject.deleteMany({ where: { workspaceId: existing.id } });
      for (const projectId of projectIds) await tx.workspaceProject.create({ data: { workspaceId: existing.id, projectId } });
    }
    if (agentIds) {
      await tx.workspaceAgentPool.deleteMany({ where: { workspaceId: existing.id } });
      for (const agentId of agentIds) await tx.workspaceAgentPool.create({ data: { workspaceId: existing.id, agentId } });
    }
    return tx.workspace.update({ where: { id: existing.id }, data, include: workspaceInclude });
  });
  return serializeWorkspace(row);
}

export async function archiveWorkspace(slug: string, actorId: string) {
  const row = await db.workspace.update({
    where: { slug },
    data: { archivedAt: new Date(), archivedById: actorId },
    include: workspaceInclude,
  }).catch(() => null);
  return row ? serializeWorkspace(row) : null;
}

export async function seedDefaultWorkspaceFromProjects() {
  const existing = await db.workspace.count();
  if (existing > 0) return null;
  const projects = await db.project.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { createdAt: "asc" } });
  if (projects.length === 0) return null;
  return db.workspace.create({
    data: {
      slug: "default",
      name: "Default Workspace",
      description: "Initial workspace seeded from existing active projects.",
      type: "internal",
      projects: { create: projects.map((project) => ({ projectId: project.id })) },
    },
  });
}
