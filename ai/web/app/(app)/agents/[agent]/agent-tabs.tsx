import Link from "next/link";
import type { ReactNode } from "react";

export default function AgentTabs({
  agent,
  activeTab,
  controls,
  operations,
}: {
  agent: string;
  activeTab: "controls" | "operations";
  controls: ReactNode;
  operations: ReactNode;
}) {
  const active = "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]";
  const idle = "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Link href={`/agents/${agent}`} className={`rounded-full border px-3 py-1.5 text-sm font-medium ${activeTab === "controls" ? active : idle}`}>Profile & controls</Link>
        <Link href={`/agents/${agent}?tab=operations`} className={`rounded-full border px-3 py-1.5 text-sm font-medium ${activeTab === "operations" ? active : idle}`}>Operations & activity</Link>
      </div>
      {activeTab === "controls" ? controls : operations}
    </div>
  );
}
