"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { PmOption } from "@/lib/pm-options";
import { submitPmOptionDecision } from "@/lib/agents/ops/pm-options-actions";

export default function PmOptions({
  projectSlug,
  sourceMessageId,
  surface,
  options,
  resolvedOption,
  interactive,
}: {
  projectSlug: string;
  sourceMessageId: string;
  surface: "task-chat" | "epic-chat" | "task-comment";
  options: PmOption[];
  resolvedOption?: PmOption | null;
  interactive: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (resolvedOption) {
    return (
      <div className="mt-2 inline-flex rounded-full border border-line bg-panel-soft px-2.5 py-1 text-xs font-semibold text-text-muted">
        Decision: {resolvedOption.label}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={!interactive || isPending}
          onClick={() => {
            const formData = new FormData();
            formData.set("projectSlug", projectSlug);
            formData.set("sourceMessageId", sourceMessageId);
            formData.set("surface", surface);
            formData.set("optionId", option.id);
            startTransition(async () => {
              await submitPmOptionDecision(formData);
              router.refresh();
            });
          }}
          className={interactive
            ? "rounded-lg border border-accent bg-accent px-3 py-1.5 text-xs font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
            : "rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs font-semibold text-text-muted opacity-65 disabled:cursor-not-allowed"}
          title={interactive ? `Choose ${option.label}` : "Decision option visible to the addressed human recipient"}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
