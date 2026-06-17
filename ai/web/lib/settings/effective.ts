import { db } from "@/lib/db";
import { getSystemSettings, DONE_TTL_FALLBACK_DAYS, type SystemSettingsValues } from "@/lib/settings/system";

export type IntegrationDefaults = Record<string, unknown>;

export type SettingSource = "project" | "workspace" | "system" | "fallback";

export type SourcedValue<T> = {
  value: T;
  source: SettingSource;
};

type ProjectDefaultsInput = {
  id?: string;
  defaultGitUserName: string | null;
  defaultGitUserEmail: string | null;
  doneTtlDays?: number | null;
  deploymentProvider?: string | null;
  deploymentProductionBranch?: string | null;
  deploymentPrTargetBranch?: string | null;
  deploymentMode?: string | null;
  deploymentOnMerge?: string | null;
  deploymentPipelineName?: string | null;
  deploymentHost?: string | null;
  deploymentEnvironment?: string | null;
  deploymentBitbucketWorkspace?: string | null;
  deploymentBitbucketRepoSlug?: string | null;
};

export type WorkspaceDefaults = {
  id: string;
  slug: string;
  name: string;
  defaultGitUserName: string | null;
  defaultGitUserEmail: string | null;
  doneTtlDays: number | null;
  deploymentProvider: string | null;
  deploymentProductionBranch: string | null;
  deploymentPrTargetBranch: string | null;
  deploymentMode: string | null;
  deploymentOnMerge: string | null;
  deploymentPipelineName: string | null;
  deploymentHost: string | null;
  deploymentEnvironment: string | null;
  deploymentBitbucketWorkspace: string | null;
  deploymentBitbucketRepoSlug: string | null;
  integrationDefaults: string | null;
};

export type EffectiveProjectSettings = {
  workspace: { id: string; slug: string; name: string } | null;
  gitIdentity: {
    name: SourcedValue<string | null>;
    email: SourcedValue<string | null>;
  };
  doneTtlDays: SourcedValue<number>;
  deployment: {
    provider: SourcedValue<string>;
    productionBranch: SourcedValue<string>;
    prTargetBranch: SourcedValue<string>;
    mode: SourcedValue<string>;
    onMerge: SourcedValue<string | null>;
    pipelineName: SourcedValue<string | null>;
    host: SourcedValue<string | null>;
    environment: SourcedValue<string | null>;
    bitbucketWorkspace: SourcedValue<string | null>;
    bitbucketRepoSlug: SourcedValue<string | null>;
  };
  integrationDefaults: SourcedValue<IntegrationDefaults>;
};

const workspaceSelect = {
  id: true,
  slug: true,
  name: true,
  defaultGitUserName: true,
  defaultGitUserEmail: true,
  doneTtlDays: true,
  deploymentProvider: true,
  deploymentProductionBranch: true,
  deploymentPrTargetBranch: true,
  deploymentMode: true,
  deploymentOnMerge: true,
  deploymentPipelineName: true,
  deploymentHost: true,
  deploymentEnvironment: true,
  deploymentBitbucketWorkspace: true,
  deploymentBitbucketRepoSlug: true,
  integrationDefaults: true,
} as const;

export async function getPrimaryWorkspaceDefaults(projectId: string): Promise<WorkspaceDefaults | null> {
  const link = await db.workspaceProject.findFirst({
    where: { projectId, workspace: { archivedAt: null } },
    orderBy: { createdAt: "asc" },
    select: { workspace: { select: workspaceSelect } },
  });
  return link?.workspace ?? null;
}

function sourced<T>(projectValue: T | null | undefined, workspaceValue: T | null | undefined, systemValue: T | null | undefined, fallback: T): SourcedValue<T> {
  if (projectValue != null) return { value: projectValue, source: "project" };
  if (workspaceValue != null) return { value: workspaceValue, source: "workspace" };
  if (systemValue != null) return { value: systemValue, source: "system" };
  return { value: fallback, source: "fallback" };
}

function sourcedNullable<T>(projectValue: T | null | undefined, workspaceValue: T | null | undefined, systemValue: T | null | undefined = null): SourcedValue<T | null> {
  if (projectValue != null) return { value: projectValue, source: "project" };
  if (workspaceValue != null) return { value: workspaceValue, source: "workspace" };
  if (systemValue != null) return { value: systemValue, source: "system" };
  return { value: null, source: "fallback" };
}

function parseDefaults(raw: string | null | undefined): IntegrationDefaults | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as IntegrationDefaults) : null;
  } catch {
    return null;
  }
}

function mergeIntegrationDefaults(...layers: (string | null | undefined)[]): SourcedValue<IntegrationDefaults> {
  const out: IntegrationDefaults = {};
  let source: SettingSource = "fallback";
  const [systemRaw, workspaceRaw, projectRaw] = layers;
  for (const [raw, layerSource] of [[systemRaw, "system"], [workspaceRaw, "workspace"], [projectRaw, "project"]] as const) {
    const parsed = parseDefaults(raw);
    if (parsed) {
      Object.assign(out, parsed);
      source = layerSource;
    }
  }
  return { value: out, source };
}

export async function resolveEffectiveProjectSettings(project: ProjectDefaultsInput): Promise<EffectiveProjectSettings> {
  const [workspace, system] = await Promise.all([
    project.id ? getPrimaryWorkspaceDefaults(project.id) : Promise.resolve(null),
    getSystemSettings(),
  ]);

  return buildEffectiveProjectSettings(project, workspace, system);
}

export function buildEffectiveProjectSettings(project: ProjectDefaultsInput & { integrationDefaults?: string | null }, workspace: WorkspaceDefaults | null, system: SystemSettingsValues): EffectiveProjectSettings {
  const provider = sourced(project.deploymentProvider, workspace?.deploymentProvider, null, "bitbucket");
  const productionBranch = sourced(project.deploymentProductionBranch, workspace?.deploymentProductionBranch, null, "main");
  return {
    workspace: workspace ? { id: workspace.id, slug: workspace.slug, name: workspace.name } : null,
    gitIdentity: {
      name: sourcedNullable(project.defaultGitUserName, workspace?.defaultGitUserName, system.defaultGitUserName),
      email: sourcedNullable(project.defaultGitUserEmail, workspace?.defaultGitUserEmail, system.defaultGitUserEmail),
    },
    doneTtlDays: sourced(project.doneTtlDays, workspace?.doneTtlDays, system.doneTtlDays, DONE_TTL_FALLBACK_DAYS),
    deployment: {
      provider,
      productionBranch,
      prTargetBranch: sourced(project.deploymentPrTargetBranch, workspace?.deploymentPrTargetBranch, null, productionBranch.value),
      mode: sourced(project.deploymentMode, workspace?.deploymentMode, null, "pr-only"),
      onMerge: sourcedNullable(project.deploymentOnMerge, workspace?.deploymentOnMerge),
      pipelineName: sourcedNullable(project.deploymentPipelineName, workspace?.deploymentPipelineName),
      host: sourcedNullable(project.deploymentHost, workspace?.deploymentHost),
      environment: sourcedNullable(project.deploymentEnvironment, workspace?.deploymentEnvironment),
      bitbucketWorkspace: sourcedNullable(project.deploymentBitbucketWorkspace, workspace?.deploymentBitbucketWorkspace),
      bitbucketRepoSlug: sourcedNullable(project.deploymentBitbucketRepoSlug, workspace?.deploymentBitbucketRepoSlug),
    },
    integrationDefaults: mergeIntegrationDefaults(system.integrationDefaults, workspace?.integrationDefaults, project.integrationDefaults),
  };
}

export function settingSourceLabel(source: SettingSource) {
  switch (source) {
    case "project": return "Project override";
    case "workspace": return "Inherited from workspace";
    case "system": return "Inherited from system";
    default: return "Fallback";
  }
}
