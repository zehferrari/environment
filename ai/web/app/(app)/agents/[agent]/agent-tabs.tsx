"use client";

import { useState, type ReactNode } from "react";

export default function AgentTabs({ controls, operations }: { controls: ReactNode; operations: ReactNode }) {
  const [tab, setTab] = useState<"controls" | "operations">("controls");
  const active = "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]";
  const idle = "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setTab("controls")} className={`rounded-full border px-3 py-1.5 text-sm font-medium ${tab === "controls" ? active : idle}`}>Profile & controls</button>
        <button type="button" onClick={() => setTab("operations")} className={`rounded-full border px-3 py-1.5 text-sm font-medium ${tab === "operations" ? active : idle}`}>Operations & activity</button>
      </div>
      <div hidden={tab !== "controls"}>{controls}</div>
      <div hidden={tab !== "operations"}>{operations}</div>
    </div>
  );
}
