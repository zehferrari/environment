"use client";

import { hasDirtyEditors } from "@/lib/client/editor-state";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Periodically re-fetches the current route's server payload in place
// (router.refresh — no full reload, scroll and client state preserved) so
// server-rendered status like "Working on" / idle / temperature stays live.
// Skips ticks while the tab is hidden.
export default function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !hasDirtyEditors()) router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, router]);
  return null;
}
