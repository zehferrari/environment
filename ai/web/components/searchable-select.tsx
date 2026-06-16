"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

export type SearchableSelectOption = {
  value: string;
  label: string;
};

export default function SearchableSelect({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  allowCustom = false,
  customLabel = "Use custom value",
  className = "",
  buttonClassName = "",
}: {
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  allowCustom?: boolean;
  customLabel?: string;
  className?: string;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selected = options.find((option) => option.value === value) ?? null;
  const trimmedQuery = query.trim();
  const filtered = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.label.toLowerCase().includes(q));
  }, [options, trimmedQuery]);
  const customAllowed =
    allowCustom &&
    trimmedQuery.length > 0 &&
    !options.some((option) => option.value.toLowerCase() === trimmedQuery.toLowerCase());

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  function choose(next: string) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (customAllowed) {
      choose(trimmedQuery);
      return;
    }
    if (filtered[0]) choose(filtered[0].value);
  }

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
          setQuery("");
        }}
        className={`flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-panel-soft px-3 py-2 text-left text-sm text-text outline-none transition hover:border-accent focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${buttonClassName}`}
      >
        <span className={selected || value ? "min-w-0 truncate" : "min-w-0 truncate text-text-muted"}>
          {selected?.label ?? (value || placeholder)}
        </span>
        <span className="shrink-0 text-xs text-text-muted" aria-hidden="true">
          v
        </span>
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 rounded-xl border border-line bg-panel p-2 shadow-2xl">
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={searchPlaceholder}
            className="mb-2 h-9 w-full rounded-lg border border-line bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <div role="listbox" className="max-h-64 overflow-y-auto">
            {customAllowed ? (
              <button
                type="button"
                role="option"
                aria-selected={value === trimmedQuery}
                onClick={() => choose(trimmedQuery)}
                className="mb-1 flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-text transition hover:bg-panel-soft"
              >
                <span className="min-w-0 truncate">{trimmedQuery}</span>
                <span className="shrink-0 text-xs text-text-muted">{customLabel}</span>
              </button>
            ) : null}
            {filtered.length > 0 ? (
              filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={value === option.value}
                  onClick={() => choose(option.value)}
                  className={`mt-1 flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm transition ${
                    value === option.value
                      ? "bg-accent/[0.12] text-text"
                      : "text-text-muted hover:bg-panel-soft hover:text-text"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </button>
              ))
            ) : !customAllowed ? (
              <div className="px-2 py-3 text-sm text-text-muted">No matching themes</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
