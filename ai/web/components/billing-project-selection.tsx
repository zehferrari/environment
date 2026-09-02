"use client";

import { useCallback, useEffect, useState } from "react";

export default function BillingProjectSelection({ formId, total }: { formId: string; total: number }) {
  const [selected, setSelected] = useState(0);
  const boxes = useCallback(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    return form ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[form="${formId}"][name="projectId"]`)) : [];
  }, [formId]);
  function selectAll(checked: boolean) {
    for (const box of boxes()) box.checked = checked;
    setSelected(checked ? total : 0);
  }
  useEffect(() => {
    const update = () => setSelected(boxes().filter((box) => box.checked).length);
    document.addEventListener("change", update);
    update();
    return () => document.removeEventListener("change", update);
  }, [boxes]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => selectAll(selected !== total)} className="h-9 rounded-lg border border-line bg-panel px-3 text-caption font-semibold text-text hover:border-accent">
        {selected === total ? "Clear all" : "Select all"}
      </button>
      <button type="submit" form={formId} disabled={selected === 0} className="h-9 rounded-lg bg-accent px-4 text-caption font-semibold text-bg hover:opacity-90 disabled:opacity-50">
        Summarise selected ({selected})
      </button>
      <span className="text-caption text-text-muted">All authors · all branches</span>
      <span className="sr-only" aria-live="polite">{selected} of {total} projects selected</span>
    </div>
  );
}
