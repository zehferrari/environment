"use client";

import { useEffect, useRef } from "react";
import { useActiveTab } from "@/components/task-tabs";

interface AutoScrollToLatestProps {
  watchKey?: string | number | null;
  whenTab?: string;
  behavior?: ScrollBehavior;
  block?: ScrollLogicalPosition;
}

export default function AutoScrollToLatest({
  watchKey = null,
  whenTab,
  behavior = "auto",
  block = "end",
}: AutoScrollToLatestProps) {
  const ref = useRef<HTMLDivElement>(null);
  const activeTab = useActiveTab();
  const isActive = whenTab ? activeTab === whenTab : true;

  useEffect(() => {
    if (!isActive) return;

    let raf = 0;
    const scroll = () => {
      ref.current?.scrollIntoView({ behavior, block });
    };

    raf = window.requestAnimationFrame(scroll);
    const timer = window.setTimeout(scroll, 80);

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [behavior, block, isActive, watchKey]);

  return <div ref={ref} aria-hidden="true" className="h-px w-full" />;
}
