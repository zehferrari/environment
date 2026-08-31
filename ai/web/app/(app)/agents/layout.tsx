import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/permissions";

export default async function AgentsLayout({
  children,
  detail,
}: {
  children: React.ReactNode;
  detail: React.ReactNode;
}) {
  const viewer = await getViewer();
  if (!viewer?.canAccessOwnerFeatures) notFound();
  // Ultra-wide only: opening an agent from the hub keeps the cards mounted in
  // a left rail and drops the profile beside them. Sized on AVAILABLE width
  // (a container query), not the viewport, so the sidebar's collapsed state
  // and the shell padding are already accounted for — 120rem of content only
  // exists on a 2560px-class display. Below that the open pane hides the
  // cards (data-agent-pane-open), which matches plain route navigation.
  //
  // The 0.5fr / 1.5fr split plus the profile's own 1fr / 0.5fr inner grid
  // yields the requested 0.5fr | 1fr | 0.5fr: cards | profile | activities.
  return (
    <div className="@container/agents">
      <div className="group/agents-split @min-[120rem]/agents:grid @min-[120rem]/agents:grid-cols-[0.5fr_1.5fr] @min-[120rem]/agents:items-start @min-[120rem]/agents:gap-4">
        <div className="@container/agents-col min-w-0 group-has-[[data-agent-pane-open]]/agents-split:hidden @min-[120rem]/agents:group-has-[[data-agent-pane-open]]/agents-split:block">
          {children}
        </div>
        {detail}
      </div>
    </div>
  );
}
