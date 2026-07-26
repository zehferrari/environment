"use client";

import { usePathname } from "next/navigation";

// Hosts an intercepted agent profile beside the /agents hub once the content
// area is wide enough (see AgentsLayout for the threshold). Mirrors
// WorkspacePane: parallel-route slots keep their previous content on soft
// navigation, so the pane must render nothing once the URL leaves an agent
// profile — /agents/<slug>/chat included, which is its own full page.
export default function AgentPane({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const open = /^\/agents\/[^/]+\/?$/.test(pathname);
  if (!open) return null;
  return (
    <section data-agent-pane-open aria-label="Agent detail" className="min-w-0">
      {children}
    </section>
  );
}
