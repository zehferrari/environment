"use client";

import { useCallback, useState } from "react";

// The invoice text is built on the server so the copied lines are exactly the
// lines rendered. This only moves it to the clipboard.
export default function BillingCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused outside a secure context. Say so rather
      // than showing "Copied" over a clipboard that never received anything.
      setCopied(false);
      setFailed(true);
    }
  }, [text]);

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={copy}
        className="h-9 rounded-lg border border-line bg-panel px-3 text-caption font-semibold text-text hover:border-accent"
      >
        {copied ? "Copied" : "Copy for invoice"}
      </button>
      {failed ? (
        <span className="text-caption text-warn">Clipboard blocked — select the text below instead.</span>
      ) : null}
    </span>
  );
}
