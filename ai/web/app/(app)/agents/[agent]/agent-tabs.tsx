import Link from "next/link";
import type { ReactNode } from "react";

export type AgentTab = "controls" | "images" | "operations" | "activity";

export default function AgentTabs({
  agent,
  activeTab,
  controls,
  images,
  operations,
  activity,
}: {
  agent: string;
  activeTab: AgentTab;
  controls: ReactNode;
  images: ReactNode;
  operations: ReactNode;
  activity: ReactNode;
}) {
  const active = "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]";
  const idle = "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]";
  const cls = (tab: AgentTab) =>
    `rounded-full border px-3 py-1.5 text-sm font-medium ${activeTab === tab ? active : idle}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Link href={`/agents/${agent}`} className={cls("controls")}>Profile &amp; controls</Link>
        <Link href={`/agents/${agent}?tab=images`} className={cls("images")}>Images</Link>
        <Link href={`/agents/${agent}?tab=operations`} className={cls("operations")}>Operations</Link>
        <Link href={`/agents/${agent}?tab=activity`} className={cls("activity")}>Activity</Link>
      </div>
      {activeTab === "controls" ? controls : activeTab === "images" ? images : activeTab === "operations" ? operations : activity}
    </div>
  );
}
