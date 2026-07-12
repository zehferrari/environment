type PrivateToggleProps = {
  formId?: string;
  defaultChecked?: boolean;
  disabled?: boolean;
  includeSubmittedField?: boolean;
};

/**
 * A form-compatible privacy switch. The optional submitted marker lets edit
 * actions distinguish an unchecked toggle from a form that did not expose the
 * privacy field at all.
 */
export default function PrivateToggle({
  formId,
  defaultChecked = false,
  disabled = false,
  includeSubmittedField = false,
}: PrivateToggleProps) {
  return (
    <label className="inline-flex min-h-9 items-center gap-2 text-caption text-text-muted">
      {includeSubmittedField ? (
        <input form={formId} type="hidden" name="privateSubmitted" value="1" />
      ) : null}
      <input
        form={formId}
        type="checkbox"
        role="switch"
        name="private"
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative h-5 w-9 shrink-0 rounded-full bg-line transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-panel peer-disabled:opacity-50"
      >
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-bg shadow-sm transition-transform peer-checked:translate-x-4" />
      </span>
      <span>Private</span>
    </label>
  );
}
