"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// The one app-wide toast/snackbar surface. Mounted once in app/(app)/layout.tsx
// so any client component can call useToast().show(...) — used by the unified
// create FAB to announce "X created — open" without redirecting. Auto-hides
// after 30s; dismissible; links straight to the new item.

export type ToastTone = "ok" | "error";

export type ToastInput = {
  message: string;
  href?: string;
  linkLabel?: string;
  tone?: ToastTone;
};

type ToastItem = ToastInput & { id: string };

type ToastContextValue = {
  show: (toast: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_HIDE_MS = 30_000;

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (toast: ToastInput) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setToasts((prev) => [...prev, { ...toast, id }]);
      const timer = setTimeout(() => dismiss(id), AUTO_HIDE_MS);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[70] flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border px-4 py-3 text-body shadow-[var(--shadow-float)] backdrop-blur ${
              toast.tone === "error"
                ? "border-crit/40 bg-crit/10 text-text"
                : "border-ok/40 bg-ok/10 text-text"
            }`}
          >
            <span
              aria-hidden="true"
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-caption font-bold ${
                toast.tone === "error" ? "bg-crit/20 text-crit" : "bg-ok/20 text-ok"
              }`}
            >
              {toast.tone === "error" ? "!" : "✓"}
            </span>
            <span className="min-w-0 flex-1 break-words">{toast.message}</span>
            {toast.href ? (
              <Link
                href={toast.href}
                onClick={() => dismiss(toast.id)}
                className="shrink-0 rounded-lg border border-line bg-panel px-2.5 py-1 text-caption font-semibold text-text transition hover:border-accent hover:text-accent"
              >
                {toast.linkLabel ?? "Open"}
              </Link>
            ) : null}
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-heading leading-none text-text-muted transition hover:bg-panel-soft hover:text-text"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
