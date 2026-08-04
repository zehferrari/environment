"use client";

import { useEffect } from "react";
import { useActiveTab } from "@/components/task-tabs";

export default function FocusTaskComment({ commentId }: { commentId: string }) {
  const activeTab = useActiveTab();

  useEffect(() => {
    if (activeTab !== "Comments") return;
    let frame = 0;
    const focus = () => {
      const element = document.getElementById(`task-comment-${commentId}`);
      if (!element) return;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.focus({ preventScroll: true });
    };
    frame = window.requestAnimationFrame(focus);
    const timer = window.setTimeout(focus, 120);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [activeTab, commentId]);

  return null;
}
