"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { emptyProjectBin } from "@/lib/bin/actions";

export default function EmptyBinButton({
  projectSlug,
  disabled = false,
}: {
  projectSlug: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleClick = () => {
    if (
      !confirm(
        "Permanently empty this bin? This will erase all deleted epics, tasks, comments, attachments, and chat history for this project. It cannot be undone.",
      )
    ) {
      return;
    }

    const formData = new FormData();
    formData.append("projectSlug", projectSlug);
    startTransition(async () => {
      await emptyProjectBin(formData);
      router.refresh();
    });
  };

  return (
    <button
      type="button"
      disabled={disabled || isPending}
      onClick={handleClick}
      className="rounded-lg border border-[var(--color-crit)]/30 bg-[var(--color-crit)]/[0.04] px-3 py-1.5 text-xs font-semibold text-[var(--color-crit)] transition hover:bg-[var(--color-crit)]/[0.08] disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
    >
      {isPending ? "Emptying..." : "[Empty Bin]"}
    </button>
  );
}
