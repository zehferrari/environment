import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  setProjectSettings,
  deleteProject,
} from "@/lib/projects/actions";
import { listAssignablePrincipals } from "@/lib/principals";
import { describeActivity } from "@/lib/activity";
import ActivityAgenda from "@/components/activity-agenda";
import { auth } from "@/lib/auth";
import { isWorktreeExposedRepo } from "@/lib/projects/worktree";
import { readSwitchState } from "@/lib/deploy/worktrees";
import { worktreeRepoKey } from "@/lib/deploy/repo-key";
import WorktreeSwitcher from "@/components/worktree-switcher";

export const dynamic = "force-dynamic";

const ACTIVITY_FEED_LIMIT = 30;
const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await auth();
  const project = await db.project.findUnique({
    where: { slug, deletedAt: null },
    include: {
      defaultAssignee: { select: { username: true } },
      defaultReviewer: { select: { username: true } },
      members: { where: { userId: session?.user?.id ?? "__anonymous__" }, select: { role: true } },
    },
  });
  if (!project) notFound();

  // Per-project "live preview" switcher: admin only, and only for projects
  // whose repo is a git checkout exposed to the shared worktree approach.
  // Scope the worktree options to THIS project's repo, and hide the block
  // entirely when that repo has no worktrees to choose from.
  const isAdmin = session?.user?.name === "zeh";
  const canEditDeployment = isAdmin || project.members.some((member) => member.role === "owner");
  const deploymentInputClass = "w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-70";
  const repoKey = worktreeRepoKey(project.repositoryPath);
  const eligible = isAdmin && isWorktreeExposedRepo(project.repositoryPath) && !!repoKey;
  const switchState = eligible ? await readSwitchState() : null;
  const relatedWorktrees = switchState
    ? switchState.worktrees.filter((w) => worktreeRepoKey(w.path) === repoKey)
    : [];
  const showSwitcher = eligible && switchState !== null && relatedWorktrees.length > 0;

  const [principals, activity] = await Promise.all([
    listAssignablePrincipals(),
    db.activityLog.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_FEED_LIMIT,
      include: {
        user: { select: actorSelect },
        task: { select: { title: true } },
      },
    }),
  ]);

  const feed = activity.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    label: describeActivity({
      kind: row.kind,
      payload: row.payload,
      actorName: row.user?.username ?? null,
      taskTitle: row.task?.title ?? null,
    }),
    actor: row.user
      ? {
          id: row.user.id,
          username: row.user.username,
          kind: row.user.kind,
          name: row.user.name,
          avatarUpdatedAt: row.user.avatarUpdatedAt?.toISOString() ?? null,
          agent: row.user.agent,
        }
      : null,
  }));

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <form
          action={setProjectSettings}
          className="space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm"
        >
          <input type="hidden" name="projectSlug" value={slug} />

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
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </SettingsRow>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[35fr_15fr_50fr]">
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
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
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
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-sm uppercase outline-none focus:border-[var(--color-accent)]"
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
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </SettingsRow>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SettingsRow
              label="Default git user (name)"
              hint="Author name for agent commits in this project."
            >
              <input
                type="text"
                name="defaultGitUserName"
                defaultValue={project.defaultGitUserName ?? ""}
                placeholder="Zeh Ferrari"
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </SettingsRow>

            <SettingsRow
              label="Default git user (email)"
              hint="Author email for agent commits in this project."
            >
              <input
                type="email"
                name="defaultGitUserEmail"
                defaultValue={project.defaultGitUserEmail ?? ""}
                placeholder="e@zeh.me"
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </SettingsRow>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SettingsRow
              label="Default assignee"
              hint="Pre-fills new tasks. Pulls from the active principal pool."
            >
              <select
                name="defaultAssigneeId"
                defaultValue={project.defaultAssigneeId ?? ""}
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
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
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
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
          </div>

          <SettingsRow
            label="Automatic Archive (days)"
            hint="Done tasks are automatically archived after this many days. Leave blank to use the system default."
          >
            <input
              type="number"
              name="doneTtlDays"
              min={1}
              max={365}
              defaultValue={project.doneTtlDays ?? ""}
              placeholder="System default"
              className="w-40 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </SettingsRow>


          <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Deployment
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Project deployment config is visible to everyone; only project owners can edit it.
                </p>
              </div>
              {!canEditDeployment ? (
                <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]">Read-only</span>
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
          </div>

          <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Only Reporters:
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  name="onlyReportersCanApproveActionPlans"
                  defaultChecked={project.onlyReportersCanApproveActionPlans}
                  className="mt-1 h-4 w-4 rounded border-[var(--color-line)] accent-[var(--color-accent)]"
                />
                <span>
                  <span className="block font-medium">Can Approve Plan of Actions</span>
                  <span className="block text-xs text-[var(--color-text-muted)]">
                    Reviewers and acting managers can comment on plans but cannot approve them.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  name="onlyReportersCanSetTasksDone"
                  defaultChecked={project.onlyReportersCanSetTasksDone}
                  className="mt-1 h-4 w-4 rounded border-[var(--color-line)] accent-[var(--color-accent)]"
                />
                <span>
                  <span className="block font-medium">Can Set Tasks to Done</span>
                  <span className="block text-xs text-[var(--color-text-muted)]">
                    Review can still happen normally; the final Done transition is reserved for the reporter.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
            >
              Save settings
            </button>
          </div>
        </form>

        <form
          action={deleteProject}
          className="w-1/2 space-y-2 rounded-2xl border border-[var(--color-crit)] bg-[var(--color-panel)] p-4 shadow-sm"
        >
          <input type="hidden" name="projectSlug" value={slug} />
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-crit)]">
            Danger zone
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Move this project to the bin. All its epics, tasks, and
            attachments go with it. Auto-purged after 30 days.
          </p>
          <button
            type="submit"
            className="w-full rounded-lg border border-[var(--color-crit)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--color-crit)] hover:bg-[var(--color-crit)] hover:text-[var(--color-bg)]"
          >
            Delete project
          </button>
        </form>

        {showSwitcher && switchState ? (
          <section className="space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Worktree live preview</h2>
              <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                Build a git worktree and point the live site at it. One worktree
                is served at a time; all share the same database and secrets, so
                only the served code changes. Admin only.
              </p>
            </div>
            {/* TODO (later): implement the full per-project pm.service serving
                solution — a dedicated service per project so each repo can be
                built + served independently. For now switching routes through
                the single shared PM app service (pm.service). */}
            <div className="rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3 py-2 text-xs leading-5 text-[var(--color-warn)]">
              <span className="font-semibold">TODO (later):</span> implement the
              full per-project <code>pm.service</code> serving solution (one
              service per project repo). For now switching routes through the
              single shared PM app service.
            </div>
            <WorktreeSwitcher initial={switchState} repoKey={repoKey ?? ""} />
          </section>
        ) : null}
      </div>

      <aside>
        <h2 className="mb-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Recent activity
        </h2>
        <ActivityAgenda feed={feed} />
      </aside>
    </div>
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
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="block text-xs text-[var(--color-text-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}
