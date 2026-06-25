"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  actorDisplayName,
  MessageAvatar,
  type MessageActor,
} from "@/components/message-avatar";
import { Input } from "@/components/ui/primitives";

export type AvatarComboboxOption = {
  value: string;
  label: string;
  actor?: MessageActor | null;
};

export default function AvatarCombobox({
  name,
  formId,
  defaultValue,
  options,
  emptyLabel,
  ariaLabel,
  onChange,
  multiple = false,
  defaultValues,
  onChangeMultiple,
}: {
  name: string;
  formId: string;
  // Single-select selection / default (ignored when `multiple`).
  defaultValue?: string;
  options: AvatarComboboxOption[];
  emptyLabel: string;
  ariaLabel: string;
  // Optional change callback so the combobox can be driven outside a form
  // (e.g. the board's bulk-assign toolbar) where the hidden input alone
  // isn't enough.
  onChange?: (value: string) => void;
  // Multi-select mode: renders one hidden <input name> per selected value so
  // a plain GET <form> submits them as repeated params (?name=a&name=b). The
  // dropdown rows become toggles instead of single-pick + close.
  multiple?: boolean;
  defaultValues?: string[];
  onChangeMultiple?: (values: string[]) => void;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [values, setValues] = useState<string[]>(defaultValues ?? []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    listMaxHeight: number;
  } | null>(null);

  useEffect(() => {
    setValue(defaultValue ?? "");
  }, [defaultValue]);

  useEffect(() => {
    setValues(defaultValues ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(defaultValues ?? []).join(",")]);

  // Position the dropdown panel relative to the trigger using fixed
  // coordinates. The panel renders in a portal on <body> (see below) so it
  // escapes any popup/modal `overflow` or stacking context that would
  // otherwise clip it to a single visible row.
  const updatePosition = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    // Flip up only when there isn't room below and there's more room above.
    const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    const available = openUp ? spaceAbove : spaceBelow;
    // Reserve ~52px for the search input + panel padding; clamp so the list
    // never spills past the viewport edge in either direction.
    const listMaxHeight = Math.max(120, Math.min(256, available - gap - 52));
    setCoords({
      left: rect.left,
      width: rect.width,
      top: openUp ? undefined : rect.bottom + gap,
      bottom: openUp ? window.innerHeight - rect.top + gap : undefined,
      listMaxHeight,
    });
  }, []);

  // Reposition while open; clear coords when closed.
  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    // Capture phase so scrolling inside any nested container repositions too.
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  // Close on outside click so an open dropdown doesn't trap the page. The
  // panel lives in a portal, so it's outside containerRef — exclude it too,
  // otherwise clicking an option would close before the select fires.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function selectValue(next: string) {
    setValue(next);
    onChange?.(next);
  }

  function toggleValue(next: string, checked: boolean) {
    setValues((current) => {
      const updated = checked
        ? current.includes(next) ? current : [...current, next]
        : current.filter((v) => v !== next);
      onChangeMultiple?.(updated);
      return updated;
    });
  }

  const selected = options.find((option) => option.value === value) ?? null;
  const selectedSet = useMemo(() => new Set(values), [values]);
  const selectedOptions = options.filter((option) => selectedSet.has(option.value));
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.label.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div className="relative" ref={containerRef}>
      {multiple ? (
        values.map((v) => <input key={v} form={formId} type="hidden" name={name} value={v} />)
      ) : (
        <input form={formId} type="hidden" name={name} value={value} />
      )}
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg px-2 text-left text-caption outline-none transition hover:border-accent md:h-9 md:min-h-0"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {multiple ? (
            selectedOptions.length === 0 ? (
              <span className="truncate text-text-muted">{emptyLabel}</span>
            ) : selectedOptions.length <= 3 ? (
              <span className="flex min-w-0 items-center gap-1.5">
                {selectedOptions.map((option) =>
                  option.actor ? (
                    <MessageAvatar key={option.value} actor={option.actor} size="sm" />
                  ) : (
                    <span
                      key={option.value}
                      className="truncate rounded bg-panel-soft px-1.5 py-0.5 text-text"
                    >
                      {option.label}
                    </span>
                  ),
                )}
              </span>
            ) : (
              <span className="truncate text-text">{selectedOptions.length} selected</span>
            )
          ) : (
            <>
              {selected?.actor ? <MessageAvatar actor={selected.actor} size="sm" /> : null}
              <span className={selected ? "truncate text-text" : "truncate text-text-muted"}>
                {selected ? selected.label : emptyLabel}
              </span>
            </>
          )}
        </span>
        <span className="shrink-0 text-text-muted" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && coords
        ? createPortal(
            <div
              ref={panelRef}
              style={{
                position: "fixed",
                left: coords.left,
                width: coords.width,
                top: coords.top,
                bottom: coords.bottom,
              }}
              className="z-50 rounded-card border border-line bg-panel p-2 shadow-2xl"
            >
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search..."
                className="mb-2 h-8 px-2 py-0 text-caption"
              />
              <div className="overflow-y-auto" style={{ maxHeight: coords.listMaxHeight }}>
                {multiple ? (
                  <>
                    {values.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          setValues([]);
                          onChangeMultiple?.([]);
                        }}
                        className="mb-1 min-h-11 w-full rounded-lg px-2 py-1 text-left text-nano font-semibold uppercase tracking-wider text-text-muted hover:bg-panel-soft hover:text-text md:min-h-0"
                      >
                        {emptyLabel}
                      </button>
                    ) : null}
                    {filtered.map((option) => {
                      const checked = selectedSet.has(option.value);
                      return (
                        <label
                          key={option.value}
                          className={`mt-1 flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption transition md:min-h-0 ${
                            checked
                              ? "bg-accent/[0.12] text-text"
                              : "text-text-muted hover:bg-panel-soft hover:text-text"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => toggleValue(option.value, event.currentTarget.checked)}
                            className="h-6 w-6 accent-text-accent md:h-3.5 md:w-3.5"
                          />
                          {option.actor ? <MessageAvatar actor={option.actor} size="sm" /> : null}
                          <span className="min-w-0 flex-1 truncate">
                            {option.actor ? actorDisplayName(option.actor) : option.label}
                          </span>
                        </label>
                      );
                    })}
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        selectValue("");
                        setOpen(false);
                        setQuery("");
                      }}
                      className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption transition md:min-h-0 ${
                        value === "" ? "bg-accent/[0.12] text-text" : "text-text-muted hover:bg-panel-soft hover:text-text"
                      }`}
                    >
                      <span className="grid h-11 w-11 place-items-center rounded-full border border-dashed border-line md:h-7 md:w-7">--</span>
                      <span>{emptyLabel}</span>
                    </button>
                    {filtered.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          selectValue(option.value);
                          setOpen(false);
                          setQuery("");
                        }}
                        className={`mt-1 flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption transition md:min-h-0 ${
                          value === option.value ? "bg-accent/[0.12] text-text" : "text-text-muted hover:bg-panel-soft hover:text-text"
                        }`}
                      >
                        {option.actor ? <MessageAvatar actor={option.actor} size="sm" /> : null}
                        <span className="min-w-0 flex-1 truncate">
                          {option.actor ? actorDisplayName(option.actor) : option.label}
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
