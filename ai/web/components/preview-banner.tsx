import type { HumanRole } from "@/lib/auth/roles";

export default function PreviewBanner({
  username,
  role,
}: {
  username: string;
  role: Exclude<HumanRole, "owner">;
}) {
  return (
    <aside
      data-owner-preview-banner
      aria-label="Owner preview mode"
      className="sticky top-0 z-[80] flex min-h-12 flex-wrap items-center justify-center gap-x-4 gap-y-2 border-b border-amber-400/50 bg-amber-100 px-4 py-2 text-sm font-medium text-amber-950 shadow-sm"
    >
      <span>
        Previewing as <strong>@{username}</strong> · {role === "admin" ? "Admin" : "Customer"}
      </span>
      <a
        href="/api/preview/exit"
        className="rounded-lg border border-amber-700/40 bg-white px-3 py-1.5 font-semibold text-amber-950 hover:border-amber-800 hover:bg-amber-50"
      >
        Exit preview
      </a>
    </aside>
  );
}

