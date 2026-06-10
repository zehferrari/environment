import { PersistentPmStreamProvider } from "@/components/persistent-pm-stream-provider";
import Sidebar from "@/components/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PersistentPmStreamProvider>
      <div className="flex min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
        <Sidebar />
        <main className="min-w-0 flex-1 px-6 py-5 lg:px-8">
          <div className="mx-auto max-w-[1480px]">{children}</div>
        </main>
      </div>
    </PersistentPmStreamProvider>
  );
}
