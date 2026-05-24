import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";

function slugify(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

async function createProject(formData: FormData) {
  "use server";
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const slug = slugify(name) || `proj-${Date.now()}`;
  await db.project.upsert({
    where: { slug },
    update: { name },
    create: { slug, name },
  });
  revalidatePath("/projects");
  redirect(`/projects/${slug}`);
}

export default async function ProjectsPage() {
  const [projects, deletedCount] = await Promise.all([
    db.project.findMany({
      where: { archivedAt: null, deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    db.project.count({ where: { deletedAt: { not: null } } }),
  ]);

  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <Link
          href="/projects/bin"
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          Bin{deletedCount > 0 ? ` (${deletedCount})` : ""}
        </Link>
      </div>

      <form action={createProject} className="flex gap-2 mb-6">
        <input
          name="name"
          required
          placeholder="New project name"
          className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          className="rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium px-4 shadow-sm hover:opacity-95"
        >
          Create
        </button>
      </form>

      {projects.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No projects yet.</p>
      ) : (
        <ul className="space-y-1">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.slug}`}
                className="block rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 hover:border-[var(--color-accent)] hover:shadow-sm"
              >
                <div className="text-sm font-medium">{p.name}</div>
                <div className="text-xs text-[var(--color-text-muted)]">/{p.slug}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
