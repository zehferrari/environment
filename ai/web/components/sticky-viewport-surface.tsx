"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { boardAvailableHeight, boardStickyTop } from "@/lib/board-chrome";

type StickyViewportSurfaceKind = "tasks-grid" | "epic-detail" | "task-detail";

export default function StickyViewportSurface({
  kind,
  contained = false,
  children,
}: {
  kind: StickyViewportSurfaceKind;
  contained?: boolean;
  children: ReactNode;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [viewportScrollActive, setViewportScrollActive] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const surface = surfaceRef.current;
    if (!track || !surface) return;

    let frame = 0;
    let active = true;
    let lastBoardTop = "";
    let lastBoardHeight = "";
    const layout = surface.closest("[data-board-layout]") as HTMLElement | null;
    const toolbar = layout?.querySelector("[data-board-toolbar]") as HTMLElement | null;
    const detailHeader = surface.querySelector("[data-detail-header]") as HTMLElement | null;
    const detailTabs = surface.querySelector("[data-detail-tabs]") as HTMLElement | null;

    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!active) return;

        if (detailHeader) {
          surface.style.setProperty("--detail-header-height", `${detailHeader.getBoundingClientRect().height}px`);
        }
        if (detailTabs) {
          surface.style.setProperty("--detail-tabs-height", `${detailTabs.getBoundingClientRect().height}px`);
        }

        // An intercepted detail already lives in WorkspacePane's bounded
        // viewport. It still owns the inner scrollbar, but must not overwrite
        // the board/list geometry that positioned the pane.
        if (contained || !layout) return;

        const toolbarRect = toolbar?.getBoundingClientRect();
        const toolbarMargin = toolbar
          ? Number.parseFloat(window.getComputedStyle(toolbar).marginBottom) || 0
          : 0;

        // Stick the detail header flush against the toolbar's *own* height (not
        // height + margin, and not the hardcoded --page-sticky-top). Otherwise
        // the header parks a margin's-worth below the toolbar and scrolled
        // content shows through the transparent band between the two sticky
        // bars. At 4xl the surface becomes its own sticky scroll viewport, so
        // the class-based --detail-sticky-top governs there — don't override it.
        if (toolbarRect && !window.matchMedia("(min-width: 160rem)").matches) {
          surface.style.setProperty("--detail-sticky-top", `${Math.floor(toolbarRect.height)}px`);
        } else {
          surface.style.removeProperty("--detail-sticky-top");
        }

        const stickyTop = boardStickyTop({
          toolbarHeight: toolbarRect?.height ?? 0,
          toolbarMargin,
        });
        const surfaceTop = surface.getBoundingClientRect().top;
        setViewportScrollActive((current) => {
          const next = surfaceTop <= stickyTop + 0.5;
          return current === next ? current : next;
        });
        const availableHeight = boardAvailableHeight({
          viewportHeight: window.visualViewport?.height ?? window.innerHeight,
          columnsTop: surfaceTop,
          toolbarHeight: toolbarRect?.height ?? 0,
          toolbarBottom: toolbarRect?.bottom ?? 0,
          toolbarMargin,
        });
        lastBoardTop = `${stickyTop}px`;
        lastBoardHeight = `${availableHeight}px`;
        track.style.setProperty("--sticky-viewport-height", lastBoardHeight);
        layout.style.setProperty("--board-sticky-top", lastBoardTop);
        layout.style.setProperty("--board-available-height", lastBoardHeight);
      });
    };

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(measure)
      : null;
    if (toolbar) observer?.observe(toolbar);
    if (detailHeader) observer?.observe(detailHeader);
    if (detailTabs) observer?.observe(detailTabs);
    void document.fonts?.ready.then(() => {
      if (active) measure();
    });

    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      observer?.disconnect();
      surface.style.removeProperty("--detail-header-height");
      surface.style.removeProperty("--detail-tabs-height");
      surface.style.removeProperty("--detail-sticky-top");
      if (layout?.style.getPropertyValue("--board-sticky-top") === lastBoardTop) {
        layout.style.removeProperty("--board-sticky-top");
      }
      if (layout?.style.getPropertyValue("--board-available-height") === lastBoardHeight) {
        layout.style.removeProperty("--board-available-height");
      }
    };
  }, [contained]);

  const detailStickyOriginClass = contained || viewportScrollActive
    ? "4xl:[--detail-sticky-top:0px]"
    : "";
  const viewportClass = contained
    ? "4xl:h-full 4xl:min-h-0 4xl:max-h-full 4xl:overflow-y-auto 4xl:overscroll-contain"
    : "4xl:sticky 4xl:top-[var(--page-sticky-top)] 4xl:h-[var(--sticky-viewport-height)] 4xl:max-h-[var(--page-available-height)]";
  const overflowClass = contained
    ? ""
    : viewportScrollActive
      ? "4xl:overflow-y-auto"
      : "4xl:overflow-y-visible";

  return (
    <div
      ref={trackRef}
      data-sticky-viewport-track
      data-sticky-viewport-contained={contained ? "true" : undefined}
      className={contained
        ? "min-w-0 4xl:h-full 4xl:min-h-0"
        : "min-w-0 [--sticky-viewport-height:var(--page-available-height)] 4xl:min-h-[calc(100dvh-var(--page-sticky-top))]"}
    >
      <div
        ref={surfaceRef}
        data-sticky-viewport-surface={kind}
        data-tasks-grid-surface={kind === "tasks-grid" ? "" : undefined}
        data-epic-detail-surface={kind === "epic-detail" ? "" : undefined}
        data-task-detail-surface={kind === "task-detail" ? "" : undefined}
        className={`min-w-0 [--detail-header-height:70px] [--detail-sticky-top:var(--page-sticky-top)] [--detail-tabs-height:2.75rem] ${detailStickyOriginClass} ${viewportClass} ${overflowClass}`}
      >
        {children}
      </div>
    </div>
  );
}
