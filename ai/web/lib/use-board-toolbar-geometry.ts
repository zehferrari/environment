"use client";

import { useLayoutEffect, type RefObject } from "react";
import { boardStickyTop } from "@/lib/board-chrome";

const VIEWPORT_BOTTOM_GAP = 16;

// Publish the eventual floor of the sticky project/workspace tabs separately
// from the board's own geometry. Board can temporarily move its surface lower
// (for example, below the selection toolbar), while list/detail routes always
// have an exact shared boundary immediately beneath the outer tabs.
export function useBoardToolbarGeometry(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const toolbar = ref.current;
    const layout = toolbar?.closest("[data-board-layout]") as HTMLElement | null;
    if (!toolbar || !layout) return;

    let frame = 0;
    let active = true;
    let lastTop = "";
    let lastHeight = "";

    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!active) return;
        const rect = toolbar.getBoundingClientRect();
        const marginBottom = Number.parseFloat(window.getComputedStyle(toolbar).marginBottom) || 0;
        const stickyTop = boardStickyTop({
          toolbarHeight: rect.height,
          toolbarMargin: marginBottom,
        });
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const availableHeight = Math.max(
          0,
          Math.floor(viewportHeight - stickyTop - VIEWPORT_BOTTOM_GAP),
        );
        lastTop = `${stickyTop}px`;
        lastHeight = `${availableHeight}px`;
        layout.style.setProperty("--page-sticky-top", lastTop);
        layout.style.setProperty("--page-available-height", lastHeight);
      });
    };

    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(toolbar);
    void document.fonts?.ready.then(() => {
      if (active) measure();
    });

    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      observer?.disconnect();
      if (layout.style.getPropertyValue("--page-sticky-top") === lastTop) {
        layout.style.removeProperty("--page-sticky-top");
      }
      if (layout.style.getPropertyValue("--page-available-height") === lastHeight) {
        layout.style.removeProperty("--page-available-height");
      }
    };
  }, [ref]);
}
