"use client";

import { useRouter } from "next/navigation";

export default function CloseTaskButton({ slug, contained = false }: { slug: string; contained?: boolean }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(`/projects/${slug}`)}
      className={`absolute grid h-8 w-8 place-items-center rounded-full bg-crit text-on-crit shadow-[var(--shadow-sm)] transition hover:opacity-90 ${contained ? "-right-5 -top-5" : "-right-4 -top-4"}`}
      aria-label="Close task"
      title="Close"
    >
      <span className="text-lg leading-none">×</span>
    </button>
  );
}
