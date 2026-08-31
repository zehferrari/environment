import { AgentPresenceProvider } from "@/components/agent-presence-provider";
import CommandDeck from "@/components/command-deck";
import CreateFabServer from "@/components/create-fab-server";
import { PersistentPmStreamProvider } from "@/components/persistent-pm-stream-provider";
import Sidebar from "@/components/sidebar";
import ToastProvider from "@/components/toast";
import { requireViewer } from "@/lib/auth/permissions";

export default async function AppLayout({
  children,
  chatpane,
}: {
  children: React.ReactNode;
  // Parallel slot: an intercepted agent chat renders here as a floating popup
  // over whatever board is in `children`. Empty (default.tsx → null) otherwise.
  chatpane: React.ReactNode;
}) {
  // The presence SSE endpoint is owner-only (403 otherwise). Mounting the
  // provider for non-owners would loop it through 403 reconnects forever, so
  // only owners get the live stream; everyone else keeps the SSR status hint.
  const viewer = await requireViewer();
  return (
    <PersistentPmStreamProvider>
      <ToastProvider>
        {viewer.canAccessOwnerFeatures ? <AgentPresenceProvider /> : null}
        <div className="relative flex min-h-screen text-text">
          <Sidebar />
          <main className="relative min-w-0 flex-1 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+6.5rem)] sm:px-page-x md:pt-page-y md:pb-24 lg:px-page-x-lg">
            <div className="mx-auto w-full min-w-0 max-w-[1480px] 3xl:max-w-[1780px] 4xl:max-w-[5000px]">{children}</div>
          </main>
          <CommandDeck />
        </div>
        {/* The one app-wide create (+). Context-aware, in-place, no redirects. */}
        <CreateFabServer />
        {chatpane}
      </ToastProvider>
    </PersistentPmStreamProvider>
  );
}
