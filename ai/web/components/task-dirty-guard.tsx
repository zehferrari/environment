"use client";

import { useEffect, useRef } from "react";
import { EDITOR_SAVED_EVENT, registerDirtyEditor, snapshotEditor, sameEditorSnapshot, type EditorSnapshot } from "@/lib/client/editor-state";

export default function TaskDirtyGuard({ formId, children }: { formId: string; children: React.ReactNode }) {
  const initial = useRef<EditorSnapshot | null>(null);
  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    initial.current = snapshotEditor(new FormData(form));
    const dirty = () => form.isConnected && initial.current !== null && !sameEditorSnapshot(initial.current, snapshotEditor(new FormData(form)));
    const unregister = registerDirtyEditor(dirty);
    const saved = (event: Event) => { initial.current = (event as CustomEvent<EditorSnapshot>).detail; };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty()) { event.preventDefault(); event.returnValue = ""; }
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return;
      if (dirty() && !window.confirm("You have unsaved changes. Leave without saving?")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    form.addEventListener(EDITOR_SAVED_EVENT, saved);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      unregister(); form.removeEventListener(EDITOR_SAVED_EVENT, saved);
      window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", click, true);
    };
  }, [formId]);
  return <>{children}</>;
}
