import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  setProjectSettings,
  deleteProject,
  archiveProject,
  unarchiveProject,
} from "@/lib/projects/actions";
import { listAssignablePrincipals } from "@/lib/principals";
import { auth } from "@/lib/auth";
import { isWorktreeExposedRepo } from "@/lib/projects/worktree";
import { readSwitchState } from "@/lib/deploy/worktrees";
import { displayWorktreesForRepo, worktreeRepoKey } from "@/lib/deploy/repo-key";
import WorktreeSwitcher from "@/components/worktree-switcher";
import { resolveEffectiveProjectSettings, settingSourceLabel } from "@/lib/settings/effective";

export const dynamic = "force-dynamic";

const SETTINGS_TABS = [
  { key: "general", label: "General" },
  { key: "deployment", label: "Deployment" },
  { key: "worktrees", label: "Worktree live preview" },
  { key: "availability", label: "Availability" },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseSettingsTab(value: string | string[] | undefined): SettingsTab {
  const tab = single(value);
  return SETTINGS_TABS.some((item) => item.key === tab) ? (tab as SettingsTab) : "general";
}

export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ tab?: string | string[] }>;
}) {
  const [{ slug }, sp] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as { tab?: string | string[] }),
  ]);
  const activeTab = parseSettingsTab(sp.tab);
  const session = await auth();
  const project = await db.project.findUnique({
    where: { slug, deletedAt: null },
    include: {
      defaultAssignee: { select: { username: true } },
      defaultReviewer: { select: { username: true } },
      managerAssignableAgents: { select: { userId: true } },
      members: { where: { userId: session?.user?.id ?? "__anonymous__" }, select: { role: true } },
    },
  });
  if (!project) notFound();

  // Per-project "live preview" switcher: human users only, and only for projects
  // whose repo is a git checkout exposed to the shared worktree approach.
  // Scope the worktree options to THIS project's repo, and hide the block
  // entirely when that repo has no worktrees to choose from.
  const isAdmin = session?.user?.name === "zeh";
  const isHuman = Boolean(session?.user?.id && session.user.kind !== "agent");
  const canEditDeployment = isHuman || isAdmin || project.members.some((member) => member.role === "owner");
  const deploymentInputClass = "w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-70";
  const repoKey = worktreeRepoKey(project.repositoryPath);
  const eligible = isHuman && isWorktreeExposedRepo(project.repositoryPath) && !!repoKey;
  const switchState = eligible ? await readSwitchState() : null;
  const relatedWorktrees = switchState
    ? displayWorktreesForRepo(switchState.worktrees, repoKey ?? "")
    : [];
  const showSwitcher = eligible && switchState !== null && relatedWorktrees.length > 0;

  const effectiveSettings = await resolveEffectiveProjectSettings(project);
  const principals = await listAssignablePrincipals();
  const codingAgentPrincipals = principals.filter((p) => p.kind === "agent" && p.agentRole === "coding");
  const managerAssignableUserIds = new Set(project.managerAssignableAgents.map((row) => row.userId));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <SettingsTabNav slug={slug} activeTab={activeTab} />

        {activeTab === "general" ? (
          <form action={setProjectSettings} className="space-y-5">
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="settingsScope" value="general" />

          <SettingsCard
            title="Identity & repository"
            hint="What this project is called and where its code lives."
            tone="accent"
          >
          <SettingsRow
            label="Project name"
            hint="The display name of this project."
          >
            <input
              type="text"
              name="name"
              defaultValue={project.name}
              required
              placeholder="My Project"
              className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
            />
          </SettingsRow>

          <div className="grid grid-cols-1 gap-card lg:grid-cols-[35fr_15fr_50fr]">
            <SettingsRow
              label="Project slug"
              hint="URL slug, for example patricia."
            >
              <input
                type="text"
                name="slug"
                defaultValue={slug}
                required
                placeholder="my-project"
                pattern="[a-zA-Z0-9\-_]+"
                title="Only letters, numbers, hyphens, and underscores are allowed"
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
              />
            </SettingsRow>

            <SettingsRow
              label="Project key"
              hint="Epic/Task key prefix."
            >
              <input
                type="text"
                name="workItemKeyPrefix"
                defaultValue={project.workItemKeyPrefix ?? ""}
                required
                placeholder="PH"
                pattern="[a-zA-Z][a-zA-Z0-9]{1,9}"
                title="Start with a letter; use 2-10 letters or numbers"
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y font-mono text-body uppercase outline-none focus:border-accent"
              />
            </SettingsRow>

            <SettingsRow
              label="Repository folder"
              hint="Absolute git checkout path on the host."
            >
              <input
                type="text"
                name="repositoryPath"
                defaultValue={project.repositoryPath ?? ""}
                required
                placeholder="/srv/Code/environment"
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y font-mono text-body outline-none focus:border-accent"
              />
            </SettingsRow>
          </div>
          </SettingsCard>

          <SettingsCard
            title="Git defaults"
            hint={`Authorship used for commits agents make in this project. Effective source: ${settingSourceLabel(effectiveSettings.gitIdentity.name.source)}${effectiveSettings.workspace ? ` (${effectiveSettings.workspace.name})` : ""}.`}
            tone="neutral"
          >
          <div className="grid grid-cols-1 gap-card sm:grid-cols-2">
            <SettingsRow
              label="Default git user (name)"
              hint={`Author name for agent commits in this project. Effective: ${effectiveSettings.gitIdentity.name.value ?? "not set"}.`}
            >
              <input
                type="text"
                name="defaultGitUserName"
                defaultValue={project.defaultGitUserName ?? ""}
                placeholder="Zeh Ferrari"
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
              />
            </SettingsRow>

            <SettingsRow
              label="Default git user (email)"
              hint={`Author email for agent commits in this project. Effective: ${effectiveSettings.gitIdentity.email.value ?? "not set"}.`}
            >
              <input
                type="email"
                name="defaultGitUserEmail"
                defaultValue={project.defaultGitUserEmail ?? ""}
                placeholder="e@zeh.me"
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
              />
            </SettingsRow>
          </div>
          </SettingsCard>

          <SettingsCard
            title="Task defaults"
            hint="Pre-filled values and lifecycle for new tasks."
            tone="ok"
          >
          <div className="grid grid-cols-1 gap-card sm:grid-cols-2 xl:grid-cols-3">
            <SettingsRow
              label="Default assignee"
              hint="Pre-fills new tasks. Pulls from the active principal pool."
            >
              <select
                name="defaultAssigneeId"
                defaultValue={project.defaultAssigneeId ?? ""}
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
              >
                <option value="">Unassigned</option>
                {principals.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.username}
                    {p.kind === "agent" ? " (agent)" : ""}
                  </option>
                ))}
              </select>
            </SettingsRow>

            <SettingsRow
              label="Default reviewer"
              hint="Pre-fills the reviewer on new tasks."
            >
              <select
                name="defaultReviewerId"
                defaultValue={project.defaultReviewerId ?? ""}
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
              >
                <option value="">Unassigned</option>
                {principals.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.username}
                    {p.kind === "agent" ? " (agent)" : ""}
                  </option>
                ))}
              </select>
            </SettingsRow>

            <SettingsRow
              label="Automatic Archive (days)"
              hint={`Done tasks auto-archive after this many days. Blank inherits workspace, then system. Effective: ${effectiveSettings.doneTtlDays.value}d (${settingSourceLabel(effectiveSettings.doneTtlDays.source)}).`}
            >
              <input
                type="number"
                name="doneTtlDays"
                min={1}
                max={365}
                defaultValue={project.doneTtlDays ?? ""}
                placeholder="Workspace/system default"
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
              />
            </SettingsRow>
          </div>
            <SettingsRow
              label="Integration defaults JSON"
              hint={`Provider-agnostic, non-secret config. Effective source: ${settingSourceLabel(effectiveSettings.integrationDefaults.source)}.`}
            >
              <textarea
                name="integrationDefaults"
                rows={6}
                defaultValue={project.integrationDefaults ?? ""}
                placeholder={'{\n  "deployment": { "provider": "bitbucket" }\n}'}
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y font-mono text-body outline-none focus:border-accent"
              />
            </SettingsRow>
            <SettingsRow
              label="Deploy-review prompt"
              hint={`Prompt sent when an Epic moves to Ready to Deploy. Blank inherits system/default. Effective source: ${settingSourceLabel(effectiveSettings.deployReviewPrompt.source)}.`}
            >
              <textarea
                name="deployReviewPrompt"
                rows={5}
                defaultValue={project.deployReviewPrompt ?? ""}
                placeholder={effectiveSettings.deployReviewPrompt.value}
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
              />
            </SettingsRow>
          </SettingsCard>

          <SettingsCard
            title="Manager assignment pool"
            hint="Agents acting as Epic managers or Task reviewers may only assign work to these coding agents. Leave empty to allow any active coding agent."
            tone="neutral"
          >
            {codingAgentPrincipals.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {codingAgentPrincipals.map((p) => (
                  <label
                    key={p.id}
                    className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-body"
                  >
                    <input
                      type="checkbox"
                      name="managerAssignableAgentId"
                      value={p.id}
                      defaultChecked={managerAssignableUserIds.has(p.id)}
                      className="h-4 w-4 rounded border-line accent-accent"
                    />
                    <span className="min-w-0 truncate">@{p.username}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-line bg-panel px-3 py-2 text-body text-text-muted">
                No active coding agents are available.
              </p>
            )}
          </SettingsCard>

          <SettingsCard
            title="Agent workflow"
            hint="Reserve sensitive transitions for the reporter."
            tone="warn"
          >
            <div className="grid gap-3 lg:grid-cols-3">
              <label className="flex items-start gap-3 text-body">
                <input
                  type="checkbox"
                  name="onlyReportersCanApproveActionPlans"
                  defaultChecked={project.onlyReportersCanApproveActionPlans}
                  className="mt-1 h-4 w-4 rounded border-line accent-accent"
                />
                <span>
                  <span className="block font-medium">Can Approve Plan of Actions</span>
                  <span className="block text-caption text-text-muted">
                    Agent reviewers and acting managers can comment on plans but cannot approve them.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-body">
                <input
                  type="checkbox"
                  name="onlyReportersCanSetTasksDone"
                  defaultChecked={project.onlyReportersCanSetTasksDone}
                  className="mt-1 h-4 w-4 rounded border-line accent-accent"
                />
                <span>
                  <span className="block font-medium">Can Set Tasks to Done</span>
                  <span className="block text-caption text-text-muted">
                    Agent review can still happen normally; the final Done transition is reserved for the reporter.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-body">
                <input
                  type="checkbox"
                  name="onlyReportersCanApprovePullRequests"
                  defaultChecked={project.onlyReportersCanApprovePullRequests}
                  className="mt-1 h-4 w-4 rounded border-line accent-accent"
                />
                <span>
                  <span className="block font-medium">Can Approve Pull Requests</span>
                  <span className="block text-caption text-text-muted">
                    Agent deployment PR approval is reserved for the reporter when this policy is enabled.
                  </span>
                </span>
              </label>
            </div>
          </SettingsCard>

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              className="rounded-lg bg-accent px-card py-control-y text-body font-medium text-bg shadow-sm hover:opacity-90"
            >
              Save settings
            </button>
          </div>
          </form>
        ) : null}

        {activeTab === "deployment" ? (
          <form
            action={setProjectSettings}
            className="space-y-section-gap rounded-panel border border-l-4 border-warn/40 border-l-warn bg-warn/[0.04] p-card-lg shadow-sm"
          >
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="settingsScope" value="deployment" />
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-body font-semibold tracking-tight">Deployment</h2>
                <p className="mt-1 text-caption text-text-muted">
                  Project deployment config is visible to everyone. Blank-capable fields inherit workspace defaults, then system/fallback values.
                </p>
              </div>
              {!canEditDeployment ? (
                <span className="rounded-full border border-line px-2 py-0.5 text-micro text-text-muted">Read-only</span>
              ) : null}
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <SettingsRow label="Provider" hint="Repository provider for deployment PRs.">
                <select name="deploymentProvider" defaultValue={project.deploymentProvider} disabled={!canEditDeployment} className={deploymentInputClass}>
                  <option value="bitbucket">Bitbucket</option>
                </select>
              </SettingsRow>
              <SettingsRow label="Production branch" hint="Canonical production branch.">
                <input type="text" name="deploymentProductionBranch" defaultValue={project.deploymentProductionBranch ?? "main"} disabled={!canEditDeployment} className={deploymentInputClass} />
              </SettingsRow>
              <SettingsRow label="PR target branch" hint="Destination branch for deployment PRs.">
                <input type="text" name="deploymentPrTargetBranch" defaultValue={project.deploymentPrTargetBranch ?? project.deploymentProductionBranch ?? "main"} disabled={!canEditDeployment} className={deploymentInputClass} />
              </SettingsRow>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <SettingsRow label="Mode" hint="How Monitor deploys after merge.">
                <select name="deploymentMode" defaultValue={project.deploymentMode} disabled={!canEditDeployment} className={deploymentInputClass}>
                  <option value="pr-only">PR only</option>
                  <option value="script">Script</option>
                  <option value="pipeline">Pipeline</option>
                  <option value="manual">Manual</option>
                </select>
              </SettingsRow>
              <SettingsRow label="Host" hint="Deployment host label.">
                <input type="text" name="deploymentHost" defaultValue={project.deploymentHost ?? ""} placeholder="x1" disabled={!canEditDeployment} className={deploymentInputClass} />
              </SettingsRow>
              <SettingsRow label="Environment" hint="Environment name.">
                <input type="text" name="deploymentEnvironment" defaultValue={project.deploymentEnvironment ?? ""} placeholder="production" disabled={!canEditDeployment} className={deploymentInputClass} />
              </SettingsRow>
            </div>
            <SettingsRow label="On-merge script" hint="Shell command/path run from repository root when mode is script.">
              <input type="text" name="deploymentOnMerge" defaultValue={project.deploymentOnMerge ?? ""} placeholder="./ai/openclaw/bin/deploy-on-merge" disabled={!canEditDeployment} className={`${deploymentInputClass} font-mono`} />
            </SettingsRow>
            <div className="grid gap-3 md:grid-cols-3">
              <SettingsRow label="Pipeline name" hint="Provider pipeline selector when mode is pipeline.">
                <input type="text" name="deploymentPipelineName" defaultValue={project.deploymentPipelineName ?? ""} disabled={!canEditDeployment} className={deploymentInputClass} />
              </SettingsRow>
              <SettingsRow label="Bitbucket workspace" hint="Optional override; otherwise inferred from origin.">
                <input type="text" name="deploymentBitbucketWorkspace" defaultValue={project.deploymentBitbucketWorkspace ?? ""} disabled={!canEditDeployment} className={deploymentInputClass} />
              </SettingsRow>
              <SettingsRow label="Bitbucket repo slug" hint="Optional override; otherwise inferred from origin.">
                <input type="text" name="deploymentBitbucketRepoSlug" defaultValue={project.deploymentBitbucketRepoSlug ?? ""} disabled={!canEditDeployment} className={deploymentInputClass} />
              </SettingsRow>
            </div>
            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={!canEditDeployment}
                className="rounded-lg bg-accent px-control-x py-control-y text-body font-medium text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save deployment settings
              </button>
            </div>
          </form>
        ) : null}

        {activeTab === "worktrees" ? (
          <section className="space-y-3 rounded-panel border border-line bg-panel p-card-lg shadow-sm">
            <div>
              <h2 className="text-body font-semibold tracking-tight">Worktree live preview</h2>
              <p className="mt-1 text-caption leading-5 text-text-muted">
                Build a git worktree and point the live site at it. One worktree
                is served at a time; all share the same database and secrets, so
                only the served code changes.
              </p>
            </div>
            {/* TODO (later): implement the full per-project pm.service serving
                solution — a dedicated service per project so each repo can be
                built + served independently. For now switching routes through
                the single shared PM app service (pm.service). */}
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-caption leading-5 text-warn">
              <span className="font-semibold">TODO (later):</span> implement the
              full per-project <code>pm.service</code> serving solution (one
              service per project repo). For now switching routes through the
              single shared PM app service.
            </div>
            {showSwitcher && switchState ? (
              <WorktreeSwitcher initial={switchState} repoKey={repoKey ?? ""} />
            ) : (
              <p className="rounded-lg border border-line bg-panel-soft px-3 py-2 text-body text-text-muted">
                No live-preview worktrees are available for this project repository on this host.
              </p>
            )}
          </section>
        ) : null}

        {activeTab === "availability" ? (
          <div className="grid grid-cols-1 gap-card md:grid-cols-2">
            {/* Archive — reversible, indefinite. Hides the project from the
                active lists/sidebar but keeps the board fully intact. */}
            <section className="space-y-2 rounded-panel border border-line bg-panel p-card shadow-sm">
              <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                Archive
              </div>
              {project.archivedAt ? (
                <>
                  <p className="text-caption text-text-muted">
                    This project is archived (hidden from the active project
                    lists and the sidebar). Its board, epics, and tasks are
                    untouched. Unarchive to bring it back.
                  </p>
                  <form action={unarchiveProject}>
                    <input type="hidden" name="projectSlug" value={slug} />
                    <button
                      type="submit"
                      className="w-full rounded-lg border border-accent bg-transparent px-control-x py-control-y text-caption font-medium text-accent hover:bg-accent hover:text-bg"
                    >
                      Unarchive project
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <p className="text-caption text-text-muted">
                    Hide this project from the active project lists and the
                    sidebar without deleting anything. Nothing is purged; you
                    can unarchive it any time from the Archive page.
                  </p>
                  <form action={archiveProject}>
                    <input type="hidden" name="projectSlug" value={slug} />
                    <button
                      type="submit"
                      className="w-full rounded-lg border border-line bg-transparent px-control-x py-control-y text-caption font-medium text-text hover:bg-panel-soft"
                    >
                      Archive project
                    </button>
                  </form>
                </>
              )}
            </section>

            {/* Delete — soft-delete to the 30-day bin, cascades to children. */}
            <form
              action={deleteProject}
              className="space-y-2 rounded-panel border border-crit bg-panel p-card shadow-sm"
            >
              <input type="hidden" name="projectSlug" value={slug} />
              <div className="text-micro font-semibold uppercase tracking-wider text-crit">
                Delete
              </div>
              <p className="text-caption text-text-muted">
                Move this project to the bin. All its epics, tasks, and
                attachments go with it. Auto-purged after 30 days.
              </p>
              <button
                type="submit"
                className="w-full rounded-lg border border-crit bg-transparent px-control-x py-control-y text-caption font-medium text-crit hover:bg-crit hover:text-bg"
              >
                Delete project
              </button>
            </form>
          </div>
        ) : null}
    </div>
  );
}

function SettingsTabNav({ slug, activeTab }: { slug: string; activeTab: SettingsTab }) {
  return (
    <nav className="flex flex-wrap gap-2 rounded-panel border border-line bg-panel p-2 shadow-sm" aria-label="Project settings tabs">
      {SETTINGS_TABS.map((tab) => {
        const active = tab.key === activeTab;
        return (
          <Link
            key={tab.key}
            href={`/projects/${slug}/settings?tab=${tab.key}`}
            className={`rounded-lg px-control-x py-control-y text-body font-medium transition ${
              active
                ? "bg-accent text-bg"
                : "text-text-muted hover:bg-panel-soft hover:text-text"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

const CARD_TONES = {
  neutral: "border-line border-l-line bg-panel-soft",
  accent: "border-accent/30 border-l-accent bg-accent/[0.04]",
  ok: "border-ok/30 border-l-ok bg-ok/[0.04]",
  warn: "border-warn/40 border-l-warn bg-warn/[0.04]",
} as const;

function SettingsCard({
  title,
  hint,
  tone = "neutral",
  children,
}: {
  title: string;
  hint?: string;
  tone?: keyof typeof CARD_TONES;
  children: React.ReactNode;
}) {
  return (
    <section className={`space-y-section-gap rounded-panel border border-l-4 p-card-lg shadow-sm ${CARD_TONES[tone]}`}>
      <div>
        <h2 className="text-micro font-semibold uppercase tracking-wider text-text">
          {title}
        </h2>
        {hint ? (
          <p className="mt-0.5 text-caption text-text-muted">{hint}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-micro font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="block text-caption text-text-muted">{hint}</span>
      ) : null}
    </label>
  );
}
