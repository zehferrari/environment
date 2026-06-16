"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { archiveDirectAgentChat } from "@/lib/agents/chat/direct/actions";

export default function NewChatButton({
  agentSlug,
  hasActiveHistory,
}: {
  agentSlug: string;
  hasActiveHistory: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"choice" | "archive" | "delete">("choice");
  const [customTitle, setCustomTitle] = useState("");
  const [isPending, startTransition] = useTransition();

  const handleArchive = () => {
    const formData = new FormData();
    formData.append("agentSlug", agentSlug);
    if (customTitle.trim()) {
      formData.append("customTitle", customTitle.trim());
    }
    startTransition(async () => {
      await archiveDirectAgentChat(formData);
      setOpen(false);
      setCustomTitle("");
      setStep("choice");
      window.dispatchEvent(new CustomEvent("pm:new-direct-chat", { detail: { agentSlug } }));
      router.refresh();
    });
  };

  const handleDelete = () => {
    const formData = new FormData();
    formData.append("agentSlug", agentSlug);
    formData.append("deleteToBin", "true");
    startTransition(async () => {
      await archiveDirectAgentChat(formData);
      setOpen(false);
      setStep("choice");
      window.dispatchEvent(new CustomEvent("pm:new-direct-chat", { detail: { agentSlug } }));
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        disabled={!hasActiveHistory}
        onClick={handleArchive}
        className="rounded-lg border border-line bg-panel px-control-x py-control-y text-caption font-medium text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45 transition-colors cursor-pointer"
      >
        New Chat
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-card backdrop-blur-sm transition-all duration-300"
          onClick={() => !isPending && setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md space-y-section-gap rounded-panel border border-line bg-panel p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
          >
            {step === "choice" && (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-body font-semibold uppercase tracking-wider text-text-muted">
                    New Chat Options
                  </h3>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setOpen(false)}
                    className="text-heading leading-none text-text-muted hover:text-text cursor-pointer"
                  >
                    &times;
                  </button>
                </div>
                <p className="text-body text-text-muted leading-relaxed">
                  What would you like to do with the current active chat before starting a new session?
                </p>
                <div className="grid grid-cols-1 gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setStep("archive")}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-panel-soft py-2.5 text-body font-medium text-text hover:border-accent hover:bg-panel transition cursor-pointer"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>
                    Archive Current Chat
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={handleDelete}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-crit/30 bg-crit/[0.04] py-2.5 text-body font-medium text-crit hover:bg-crit/[0.08] transition cursor-pointer"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    {isPending ? "Moving to Bin..." : "Move Current Chat to Bin"}
                  </button>
                </div>
                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded-lg border border-line bg-panel-soft px-4 py-1.5 text-caption font-medium text-text-muted hover:border-accent hover:text-accent transition cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {step === "archive" && (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-body font-semibold uppercase tracking-wider text-text-muted">
                    Archive Active Chat
                  </h3>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setOpen(false)}
                    className="text-heading leading-none text-text-muted hover:text-text cursor-pointer"
                  >
                    &times;
                  </button>
                </div>
                <div className="space-y-3">
                  <label className="block text-caption font-medium text-text-muted">
                    Archive Title (Optional)
                  </label>
                  <input
                    type="text"
                    disabled={isPending}
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder="Enter custom title or leave blank to auto-generate"
                    className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body outline-none focus:border-accent disabled:opacity-50"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleArchive();
                    }}
                  />
                </div>
                <div className="flex justify-between pt-2">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setStep("choice")}
                    className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent transition disabled:opacity-50 cursor-pointer"
                  >
                    Back
                  </button>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => setOpen(false)}
                      className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent transition disabled:opacity-50 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={handleArchive}
                      className="rounded-lg bg-accent px-4 py-1.5 text-caption font-medium text-bg hover:opacity-90 transition disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
                    >
                      {isPending ? (
                        <>
                          <svg className="animate-spin h-3 w-3 text-current" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Archiving...
                        </>
                      ) : (
                        "Confirm & Archive"
                      )}
                    </button>
                  </div>
                </div>
              </>
            )}

            {step === "delete" && (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-body font-semibold uppercase tracking-wider text-crit">
                    Move Chat to Trash
                  </h3>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setOpen(false)}
                    className="text-heading leading-none text-text-muted hover:text-text cursor-pointer"
                  >
                    &times;
                  </button>
                </div>
                <p className="text-body text-text-muted leading-relaxed">
                  Are you sure you want to move this chat to the trash bin? It and its attachments will be permanently deleted after 7 days.
                </p>
                <div className="flex justify-between pt-2">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setStep("choice")}
                    className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent transition disabled:opacity-50 cursor-pointer"
                  >
                    Back
                  </button>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => setOpen(false)}
                      className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent transition disabled:opacity-50 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={handleDelete}
                      className="rounded-lg bg-crit px-4 py-1.5 text-caption font-medium text-white hover:opacity-90 transition disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
                    >
                      {isPending ? (
                        <>
                          <svg className="animate-spin h-3 w-3 text-current" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Deleting...
                        </>
                      ) : (
                        "Delete Chat"
                      )}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
