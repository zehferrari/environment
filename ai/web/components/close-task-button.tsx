"use client";

import { useRouter } from "next/navigation";

export default function CloseTaskButton({ slug }: { slug: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(`/projects/${slug}`)}
      className="h-9 rounded-lg bg-crit px-3 text-body font-medium text-on-crit hover:opacity-90"
      aria-label="Close task"
    >
      Close
    </button>
  );
}
