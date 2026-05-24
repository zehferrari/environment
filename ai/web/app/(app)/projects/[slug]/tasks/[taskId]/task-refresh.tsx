"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function TaskRefresh({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      router.refresh();
    }, 1000);
    return () => window.clearInterval(id);
  }, [active, router]);

  return null;
}
