"use client";

import { useRouter } from "next/navigation";

export default function CloseTaskButton({ slug }: { slug: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(`/projects/${slug}`)}
      className="absolute -right-4 -top-4 grid h-8 w-8 place-items-center rounded-full bg-crit text-on-crit shadow-[var(--shadow-sm)] transition hover:opacity-90"
      aria-label="Close task"
      title="Close"
    >
      <span className="text-lg leading-none">×</span>
    </button>
  );
}
