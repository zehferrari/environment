import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import { normalizeWorkItemKeyPrefix } from "@/lib/work-items/keys";
import AddProjectFab from "./add-project-fab";

export const dynamic = "force-dynamic";

// Create a project with its settings up front (mirrors the task/epic "new"
// modal: one form, the project's own fields).
async function createProject(formData: FormData) {
  "use server";
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 200) return;
  const description = String(formData.get("description") ?? "").trim() || null;
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  if (!slug || !/^[a-zA-Z0-9\-_]+$/.test(slug)) {
    throw new Error("Project slug is required and may only contain letters, numbers, hyphens, and underscores.");
  }
  const repositoryPath = String(formData.get("repositoryPath") ?? "").trim();
  if (!repositoryPath) throw new Error("Repository folder is required");
  const rawWorkItemKeyPrefix = String(formData.get("workItemKeyPrefix") ?? "").trim();
  const workItemKeyPrefix = normalizeWorkItemKeyPrefix(rawWorkItemKeyPrefix);
  if (!workItemKeyPrefix) {
    throw new Error("Project key must start with a letter and contain only 2-10 letters or numbers.");
  }
  const defaultGitUserName =
    String(formData.get("defaultGitUserName") ?? "").trim() || null;
  const defaultGitUserEmail =
    String(formData.get("defaultGitUserEmail") ?? "").trim() || null;
  const defaultAssigneeId =
    String(formData.get("defaultAssigneeId") ?? "").trim() || null;
  const defaultReviewerId =
    String(formData.get("defaultReviewerId") ?? "").trim() || null;
  const doneTtlRaw = String(formData.get("doneTtlDays") ?? "").trim();
  const doneTtlDays =
    doneTtlRaw === "" ? null : Math.max(1, Math.min(365, Number(doneTtlRaw) || 5));

  if (await db.project.findUnique({ where: { slug }, select: { id: true } })) {
    throw new Error("Project slug is already in use.");
  }
  if (await db.project.findUnique({ where: { workItemKeyPrefix }, select: { id: true } })) {
    throw new Error("Project key is already in use.");
  }

  await db.project.create({
    data: {
      slug,
      name,
      description,
      repositoryPath,
      workItemKeyPrefix,
      defaultGitUserName,
      defaultGitUserEmail,
      defaultAssigneeId,
      defaultReviewerId,
      doneTtlDays,
    },
  });
  revalidatePath("/projects");
  redirect(`/projects/${slug}`);
}

export default async function ProjectsPage() {
  const [projects, deletedCount, archivedCount, principals] = await Promise.all([
    db.project.findMany({
      where: { archivedAt: null, deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        repositoryPath: true,
        defaultGitUserName: true,
        defaultGitUserEmail: true,
        doneTtlDays: true,
      },
    }),
    db.project.count({ where: { deletedAt: { not: null } } }),
    db.project.count({ where: { archivedAt: { not: null }, deletedAt: null } }),
    listAssignablePrincipals(),
  ]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/projects/archive"
            className="rounded-lg border border-line bg-panel px-3 py-1.5 text-xs font-medium text-text-muted hover:border-accent hover:text-accent"
          >
            Archive{archivedCount > 0 ? ` (${archivedCount})` : ""}
          </Link>
          <Link
            href="/projects/bin"
            className="rounded-lg border border-line bg-panel px-3 py-1.5 text-xs font-medium text-text-muted hover:border-accent hover:text-accent"
          >
            Bin{deletedCount > 0 ? ` (${deletedCount})` : ""}
          </Link>
        </div>
      </div>

      {projects.length === 0 ? (
        <p className="text-sm text-text-muted">
          No projects yet. Use the + button to create one.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.slug}`}
              className="flex flex-col gap-2 rounded-2xl border border-line bg-panel p-4 shadow-sm transition hover:border-accent hover:shadow-md"
            >
              <div>
                <div className="text-base font-semibold tracking-tight">
                  {p.name}
                </div>
                <div className="text-xs text-text-muted">
                  /{p.slug}
                </div>
              </div>
              {p.description ? (
                <p className="line-clamp-2 text-xs text-text-muted">
                  {p.description}
                </p>
              ) : null}
              <dl className="mt-auto space-y-1 text-[11px] text-text-muted">
                {p.repositoryPath ? (
                  <div className="flex gap-2">
                    <dt className="shrink-0 uppercase tracking-wider">Repo</dt>
                    <dd className="truncate font-mono" title={p.repositoryPath}>
                      {p.repositoryPath}
                    </dd>
                  </div>
                ) : null}
                {p.defaultGitUserName || p.defaultGitUserEmail ? (
                  <div className="flex gap-2">
                    <dt className="shrink-0 uppercase tracking-wider">Git</dt>
                    <dd className="truncate">
                      {p.defaultGitUserName ?? ""}
                      {p.defaultGitUserEmail ? ` <${p.defaultGitUserEmail}>` : ""}
                    </dd>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <dt className="shrink-0 uppercase tracking-wider">Auto archive</dt>
                  <dd>
                    {p.doneTtlDays != null ? `${p.doneTtlDays}d` : "default"}
                  </dd>
                </div>
              </dl>
            </Link>
          ))}
        </div>
      )}

      <AddProjectFab
        principals={principals.map((p) => ({ id: p.id, name: p.name }))}
        createProjectAction={createProject}
      />
    </div>
  );
}
