import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import AddProjectFab from "./add-project-fab";

export const dynamic = "force-dynamic";

function slugify(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

// Create a project with its settings up front (mirrors the task/epic "new"
// modal: one form, the project's own fields).
async function createProject(formData: FormData) {
  "use server";
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 200) return;
  const description = String(formData.get("description") ?? "").trim() || null;
  const repositoryPath =
    String(formData.get("repositoryPath") ?? "").trim() || null;
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

  // Unique slug from the name; append a short suffix on collision.
  let slug = slugify(name) || `proj-${Date.now().toString(36)}`;
  if (await db.project.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  }

  await db.project.create({
    data: {
      slug,
      name,
      description,
      repositoryPath,
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
  const [projects, deletedCount, principals] = await Promise.all([
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
    listAssignablePrincipals(),
  ]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <Link
          href="/projects/bin"
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          Bin{deletedCount > 0 ? ` (${deletedCount})` : ""}
        </Link>
      </div>

      {projects.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No projects yet. Use the + button to create one.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.slug}`}
              className="flex flex-col gap-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm transition hover:border-[var(--color-accent)] hover:shadow-md"
            >
              <div>
                <div className="text-base font-semibold tracking-tight">
                  {p.name}
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  /{p.slug}
                </div>
              </div>
              {p.description ? (
                <p className="line-clamp-2 text-xs text-[var(--color-text-muted)]">
                  {p.description}
                </p>
              ) : null}
              <dl className="mt-auto space-y-1 text-[11px] text-[var(--color-text-muted)]">
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
                  <dt className="shrink-0 uppercase tracking-wider">Done TTL</dt>
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
