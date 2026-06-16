"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { emptyProjectBin } from "@/lib/bin/actions";
import ConfirmPopup from "@/components/confirm-popup";

export default function EmptyBinButton({
  projectSlug,
  disabled = false,
}: {
  projectSlug: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const doEmpty = () => {
    const formData = new FormData();
    formData.append("projectSlug", projectSlug);
    startTransition(async () => {
      await emptyProjectBin(formData);
      setConfirmOpen(false);
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled || isPending}
        onClick={() => setConfirmOpen(true)}
        className="rounded-lg border border-crit/30 bg-crit/4 px-3 py-1.5 text-xs font-semibold text-crit transition hover:bg-crit/8 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
      >
        {isPending ? "Emptying..." : "[Empty Bin]"}
      </button>
      <ConfirmPopup
        open={confirmOpen}
        title="Empty this bin"
        description="This will permanently erase all deleted epics, tasks, comments, attachments, and chat history for this project. It cannot be undone."
        confirmLabel="Empty Bin"
        danger
        busy={isPending}
        onConfirm={doEmpty}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
