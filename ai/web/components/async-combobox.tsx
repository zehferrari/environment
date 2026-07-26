"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A searchable single-select combobox that loads its options from an async
// `loadOptions(query)`. The same component backs BOTH bounded pickers (pass an
// in-memory filter as the loader) and scalable ones (pass a server-search
// action) so every picker in the create FAB looks and behaves identically and
// stays fast no matter how large a project's epic/task list grows.
//
// Submits through a hidden <input form={formId} name={name}> so it can live
// anywhere relative to its form; the dropdown is portaled to <body> to escape
// overflow/stacking contexts.

export type AsyncOption = { value: string; label: string; hint?: string };

const DEBOUNCE_MS = 220;

export default function AsyncCombobox({
  name,
  formId,
  loadOptions,
  initialOption = null,
  placeholder = "Select…",
  emptyLabel = "No matches",
  ariaLabel,
  allowClear = false,
  disabled = false,
  onChange,
  // Bumping this key resets the selection to `initialOption` (e.g. when the
  // parent project changes and a stale epic selection must clear).
  resetSignal,
}: {
  name: string;
  formId?: string;
  loadOptions: (query: string) => Promise<AsyncOption[]>;
  initialOption?: AsyncOption | null;
  placeholder?: string;
  emptyLabel?: string;
  ariaLabel?: string;
  allowClear?: boolean;
  disabled?: boolean;
  onChange?: (value: string, option: AsyncOption | null) => void;
  resetSignal?: unknown;
}) {
  const [selected, setSelected] = useState<AsyncOption | null>(initialOption);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<AsyncOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const listboxId = useId();

  // Reset to the provided initial option whenever the reset signal changes.
  useEffect(() => {
    setSelected(initialOption);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const runSearch = useCallback(
    async (q: string) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      try {
        const results = await loadOptions(q);
        if (seq === requestSeq.current) setOptions(results);
      } catch {
        if (seq === requestSeq.current) setOptions([]);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [loadOptions],
  );

  // Debounced search while open.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => runSearch(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query, runSearch]);

  const positionDropdown = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.bottom + 4, left: r.left, width: r.width });
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    positionDropdown();
    setQuery("");
    setOpen(true);
    void runSearch("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [disabled, positionDropdown, runSearch]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  // Close on outside interaction / reposition on scroll+resize.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      const dropdown = document.getElementById(`${listboxId}-dropdown`);
      if (dropdown?.contains(target)) return;
      closeMenu();
    };
    const onReposition = () => positionDropdown();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, closeMenu, positionDropdown, listboxId]);

  const pick = (option: AsyncOption) => {
    setSelected(option);
    onChange?.(option.value, option);
    closeMenu();
  };

  const clear = () => {
    setSelected(null);
    onChange?.("", null);
  };

  const dropdown =
    open && rect
      ? createPortal(
          <div
            id={`${listboxId}-dropdown`}
            style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width }}
            className="z-[80] max-h-72 overflow-hidden rounded-lg border border-line bg-panel shadow-[var(--shadow-float)]"
          >
            <div className="border-b border-line p-2">
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeMenu();
                    triggerRef.current?.focus();
                  }
                }}
                placeholder="Search…"
                aria-label="Search options"
                className="h-9 w-full rounded-md border border-line bg-bg px-2 text-caption outline-none focus:border-accent"
              />
            </div>
            <ul role="listbox" className="max-h-56 overflow-y-auto py-1 text-caption">
              {loading ? (
                <li className="px-3 py-2 text-text-muted">Searching…</li>
              ) : options.length === 0 ? (
                <li className="px-3 py-2 text-text-muted">{emptyLabel}</li>
              ) : (
                options.map((option) => (
                  <li key={option.value}>
                    <button
                      type="button"
                      onClick={() => pick(option)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition hover:bg-panel-soft ${
                        selected?.value === option.value ? "bg-accent/[0.10] text-accent" : "text-text"
                      }`}
                    >
                      <span className="truncate">{option.label}</span>
                      {option.hint ? (
                        <span className="shrink-0 text-nano text-text-muted">{option.hint}</span>
                      ) : null}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>,
          document.body,
        )
      : null;

  const displayLabel = useMemo(() => selected?.label ?? "", [selected]);

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" form={formId} name={name} value={selected?.value ?? ""} />
      <div className="flex items-stretch gap-1">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => (open ? closeMenu() : openMenu())}
          className="flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg px-2 text-caption outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={`truncate ${selected ? "text-text" : "text-text-muted"}`}>
            {displayLabel || placeholder}
          </span>
          <span aria-hidden="true" className="shrink-0 text-text-muted">▾</span>
        </button>
        {allowClear && selected && !disabled ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear selection"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line text-text-muted transition hover:border-accent hover:text-accent"
          >
            &times;
          </button>
        ) : null}
      </div>
      {dropdown}
    </div>
  );
}
