import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  setProjectSettings,
  deleteProject,
} from "@/lib/projects/actions";
import { listAssignablePrincipals } from "@/lib/principals";
import { describeActivity } from "@/lib/activity";
import ActivityAgenda from "@/components/activity-agenda";

export const dynamic = "force-dynamic";

const ACTIVITY_FEED_LIMIT = 30;

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await db.project.findUnique({
    where: { slug, deletedAt: null },
    include: {
      defaultAssignee: { select: { username: true } },
      defaultReviewer: { select: { username: true } },
    },
  });
  if (!project) notFound();

  const [principals, activity] = await Promise.all([
    listAssignablePrincipals(),
    db.activityLog.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_FEED_LIMIT,
      include: {
        user: { select: { username: true } },
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
            label="Repository folder"
            hint="Absolute path on the host where this project's git checkout lives."
          >
            <input
              type="text"
              name="repositoryPath"
              defaultValue={project.repositoryPath ?? ""}
              placeholder="/srv/Code/environment"
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </SettingsRow>

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
            label="Days to keep Done"
            hint="Tasks in Done older than this many days are hidden from the board. They stay reachable via direct links. Leave blank to use the system default."
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
