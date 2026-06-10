"use client";

import { useEffect, useMemo, useState } from "react";
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
}: {
  name: string;
  formId: string;
  defaultValue: string;
  options: AvatarComboboxOption[];
  emptyLabel: string;
  ariaLabel: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  const selected = options.find((option) => option.value === value) ?? null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.label.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div className="relative">
      <input form={formId} type="hidden" name={name} value={value} />
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 text-left text-xs outline-none transition hover:border-[var(--color-accent)]"
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected?.actor ? <MessageAvatar actor={selected.actor} size="sm" /> : null}
          <span className={selected ? "truncate text-[var(--color-text)]" : "truncate text-[var(--color-text-muted)]"}>
            {selected ? selected.label : emptyLabel}
          </span>
        </span>
        <span className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-2 shadow-2xl">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search..."
            className="mb-2 h-8 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          <div className="max-h-64 overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                setValue("");
                setOpen(false);
                setQuery("");
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                value === "" ? "bg-[var(--color-accent)]/[0.12] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)]"
              }`}
            >
              <span className="grid h-7 w-7 place-items-center rounded-full border border-dashed border-[var(--color-line)]">--</span>
              <span>{emptyLabel}</span>
            </button>
            {filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setValue(option.value);
                  setOpen(false);
                  setQuery("");
                }}
                className={`mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                  value === option.value ? "bg-[var(--color-accent)]/[0.12] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)]"
                }`}
              >
                {option.actor ? <MessageAvatar actor={option.actor} size="sm" /> : null}
                <span className="min-w-0 flex-1 truncate">
                  {option.actor ? actorDisplayName(option.actor) : option.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
