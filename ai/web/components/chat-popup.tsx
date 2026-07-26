"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

// Ultra-wide only: an agent chat, opened by soft navigation from any board,
// renders inside this draggable / resizable / closeable floating window that
// sits ON TOP of the current page (route interception keeps the board mounted
// behind it). Below ultra-wide the same intercepted content fills the viewport
// like the normal full-page chat. A hard load of /agents/<slug>/chat bypasses
// interception entirely and renders the canonical page.
const ULTRA_WIDE = "(min-width: 160rem)"; // 2560px — matches the app's "ultra-wide"

type Box = { x: number; y: number; w: number; h: number };

export default function ChatPopup({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // Parallel-route slots keep their last content on soft navigation, so only
  // render while the URL is actually an agent chat.
  const open = /^\/agents\/[^/]+\/chat\/?$/.test(pathname ?? "");

  const [ultraWide, setUltraWide] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  useEffect(() => {
    const mq = window.matchMedia(ULTRA_WIDE);
    const sync = () => setUltraWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Below ultra-wide there is no popup: hard-load the same URL so the canonical
  // full-page chat route renders (a hard load bypasses interception). Read the
  // match directly to avoid firing before the state effect above settles.
  useEffect(() => {
    if (!open) return;
    if (!window.matchMedia(ULTRA_WIDE).matches) {
      window.location.replace(window.location.href);
    }
  }, [open]);

  // Seed a centred window the first time it opens on an ultra-wide screen.
  useEffect(() => {
    if (!open || !ultraWide || box) return;
    const w = Math.min(1180, Math.round(window.innerWidth * 0.62));
    const h = Math.min(880, Math.round(window.innerHeight * 0.84));
    setBox({ x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2), w, h });
  }, [open, ultraWide, box]);

  const close = useCallback(() => {
    // Intercepted opens always have the underlying board in history.
    router.back();
  }, [router]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Pointer drag (title bar) and resize (corner grip), tracked on the window so
  // the gesture keeps working if the cursor outruns the element.
  useEffect(() => {
    if (!open || !ultraWide) return;
    const onMove = (e: PointerEvent) => {
      if (dragRef.current) {
        const d = dragRef.current;
        setBox((b) => b && ({
          ...b,
          x: clamp(d.origX + (e.clientX - d.startX), 8 - b.w + 120, window.innerWidth - 120),
          y: clamp(d.origY + (e.clientY - d.startY), 8, window.innerHeight - 48),
        }));
      } else if (resizeRef.current) {
        const r = resizeRef.current;
        setBox((b) => b && ({
          ...b,
          w: clamp(r.origW + (e.clientX - r.startX), 460, window.innerWidth - 32),
          h: clamp(r.origH + (e.clientY - r.startY), 380, window.innerHeight - 32),
        }));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [open, ultraWide]);

  // Not open, or below ultra-wide (redirecting to the canonical page): render
  // nothing.
  if (!open || !ultraWide) return null;

  const style = box
    ? { left: box.x, top: box.y, width: box.w, height: box.h }
    : { left: "8vw", top: "6vh", width: "62vw", height: "84vh" };

  return (
    // Non-blocking backdrop: a faint scrim over the board, but clicks outside
    // the window fall through so the board stays usable while chatting.
    <div className="pointer-events-none fixed inset-0 z-50">
      <div
        role="dialog"
        aria-label="Agent chat"
        className="pointer-events-auto fixed flex flex-col overflow-hidden rounded-panel border border-line bg-bg shadow-[var(--shadow-float)]"
        style={style}
      >
        <div
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragRef.current = { startX: e.clientX, startY: e.clientY, origX: box?.x ?? 0, origY: box?.y ?? 0 };
            document.body.style.userSelect = "none";
          }}
          className="flex shrink-0 cursor-grab items-center justify-between gap-2 border-b border-line bg-panel px-3 py-2 active:cursor-grabbing"
        >
          <span className="flex items-center gap-2 text-caption font-semibold text-text-muted">
            <GripIcon />
            Agent chat
          </span>
          <CloseButton onClick={close} />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        {/* Resize grip */}
        <div
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: box?.w ?? 0, origH: box?.h ?? 0 };
            document.body.style.userSelect = "none";
          }}
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          aria-hidden="true"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" className="text-line-strong">
            <path d="M11 15L15 11M6 15L15 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function CloseButton({ onClick, className = "" }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close chat"
      title="Close"
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border border-crit/40 bg-crit text-on-crit shadow-[var(--shadow-sm)] transition hover:scale-105 hover:opacity-90 ${className}`}
    >
      <span className="text-lg leading-none" aria-hidden="true">×</span>
    </button>
  );
}

function GripIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
    </svg>
  );
}
