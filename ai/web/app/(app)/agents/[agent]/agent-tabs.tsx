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
  const active = "border-accent bg-accent-soft text-accent";
  const idle = "border-line bg-panel text-text-muted hover:text-text";
  const cls = (tab: AgentTab) =>
    `rounded-full border px-control-x py-control-y text-body font-medium ${activeTab === tab ? active : idle}`;

  return (
    <div className="space-y-section-gap">
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
