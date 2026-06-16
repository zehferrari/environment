import { PersistentPmStreamProvider } from "@/components/persistent-pm-stream-provider";
import Sidebar from "@/components/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PersistentPmStreamProvider>
      <div className="flex min-h-screen bg-bg text-text">
        <Sidebar />
        <main className="min-w-0 flex-1 px-page-x pt-page-y pb-[calc(env(safe-area-inset-bottom)+6rem)] md:py-page-y lg:px-page-x-lg">
          <div className="mx-auto w-full min-w-0 max-w-[1480px]">{children}</div>
        </main>
      </div>
    </PersistentPmStreamProvider>
  );
}
