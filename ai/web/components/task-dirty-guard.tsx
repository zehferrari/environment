"use client";

import { useEffect, useRef, useCallback } from "react";

export default function TaskDirtyGuard({ children }: { children: React.ReactNode }) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const initialValuesRef = useRef<Record<string, string>>({});
  const isDirtyRef = useRef(false);

  const captureInitialValues = useCallback(() => {
    const form = document.getElementById("taskMain") as HTMLFormElement | null;
    if (!form) return;
    formRef.current = form;
    const data = new FormData(form);
    const values: Record<string, string> = {};
    for (const [key, value] of data.entries()) {
      if (typeof value === "string") {
        values[key] = value;
      }
    }
    initialValuesRef.current = values;
  }, []);

  const checkDirty = useCallback(() => {
    const form = formRef.current;
    if (!form) return false;
    const data = new FormData(form);
    const current: Record<string, string> = {};
    for (const [key, value] of data.entries()) {
      if (typeof value === "string") {
        current[key] = value;
      }
    }
    const initial = initialValuesRef.current;
    const keys = new Set([...Object.keys(initial), ...Object.keys(current)]);
    for (const key of keys) {
      if ((initial[key] ?? "") !== (current[key] ?? "")) {
        return true;
      }
    }
    return false;
  }, []);

  useEffect(() => {
    // Capture initial values after mount
    const timer = setTimeout(captureInitialValues, 100);

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (checkDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (checkDirty()) {
        const confirmed = window.confirm("You have unsaved changes. Leave without saving?");
        if (!confirmed) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleClick, true);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleClick, true);
    };
  }, [captureInitialValues, checkDirty]);

  return <>{children}</>;
}
