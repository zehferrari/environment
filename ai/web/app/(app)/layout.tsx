import { PersistentPmStreamProvider } from "@/components/persistent-pm-stream-provider";
import Sidebar from "@/components/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PersistentPmStreamProvider>
      <div className="relative flex min-h-screen text-text">
        <Sidebar />
        <main className="relative min-w-0 flex-1 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+6.5rem)] sm:px-page-x md:pt-page-y md:pb-24 lg:px-page-x-lg">
          <div className="mx-auto w-full min-w-0 max-w-[1480px]">{children}</div>
        </main>
      </div>
    </PersistentPmStreamProvider>
  );
}
