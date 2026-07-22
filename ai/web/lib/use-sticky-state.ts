"use client";

import { useEffect, useState, type RefObject } from "react";

// CSS has no widely-supported `:stuck` selector. Mirror the toolbar's actual
// sticky state so its compact context label only appears after the page title
// has scrolled away.
export function useStickyState(ref: RefObject<HTMLElement | null>) {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    let frame = 0;
    let active = true;

    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const element = ref.current;
        if (!active || !element) return;
        const stickyTop = Number.parseFloat(window.getComputedStyle(element).top) || 0;
        const next = window.scrollY > 0 && element.getBoundingClientRect().top <= stickyTop + 0.5;
        setStuck((current) => current === next ? current : next);
      });
    };

    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    window.visualViewport?.addEventListener("resize", measure);

    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [ref]);

  return stuck;
}
