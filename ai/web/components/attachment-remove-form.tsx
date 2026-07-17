"use client";

export default function AttachmentRemoveForm({
  attachmentId,
  filename,
  projectSlug,
  deleteAction,
}: {
  attachmentId: string;
  filename: string;
  projectSlug: string;
  deleteAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <form
      action={deleteAction}
      className="absolute -right-1.5 -top-1.5 z-20"
      onSubmit={(event) => {
        if (!window.confirm(`Remove attachment "${filename}"?`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="projectSlug" value={projectSlug} />
      <input type="hidden" name="attachmentId" value={attachmentId} />
      <button
        type="submit"
        aria-label={`Remove ${filename}`}
        title="Remove"
        className="grid h-6 w-6 place-items-center rounded-full border border-crit/60 bg-panel text-nano font-bold text-crit shadow-sm hover:bg-crit hover:text-on-crit"
      >
        <span aria-hidden="true">X</span>
      </button>
    </form>
  );
}
