"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  actorDisplayName,
  MessageAvatar,
  type MessageActor,
} from "@/components/message-avatar";

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

  useEffect(() => {
    setValue(defaultValue ?? "");
  }, [defaultValue]);

  useEffect(() => {
    setValues(defaultValues ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(defaultValues ?? []).join(",")]);

  // Close on outside click so an open dropdown doesn't trap the page.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
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
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg px-2 text-left text-xs outline-none transition hover:border-accent"
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
      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-xl border border-line bg-panel p-2 shadow-2xl">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search..."
            className="mb-2 h-8 w-full rounded-lg border border-line bg-bg px-2 text-xs outline-none focus:border-accent"
          />
          <div className="max-h-64 overflow-y-auto">
            {multiple ? (
              <>
                {values.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setValues([]);
                      onChangeMultiple?.([]);
                    }}
                    className="mb-1 w-full rounded-lg px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-text-muted hover:bg-panel-soft hover:text-text"
                  >
                    {emptyLabel}
                  </button>
                ) : null}
                {filtered.map((option) => {
                  const checked = selectedSet.has(option.value);
                  return (
                    <label
                      key={option.value}
                      className={`mt-1 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                        checked
                          ? "bg-accent/[0.12] text-text"
                          : "text-text-muted hover:bg-panel-soft hover:text-text"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => toggleValue(option.value, event.currentTarget.checked)}
                        className="h-3.5 w-3.5 accent-text-accent"
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
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                    value === "" ? "bg-accent/[0.12] text-text" : "text-text-muted hover:bg-panel-soft hover:text-text"
                  }`}
                >
                  <span className="grid h-7 w-7 place-items-center rounded-full border border-dashed border-line">--</span>
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
                    className={`mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
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
        </div>
      ) : null}
    </div>
  );
}
