"use client";

import React, { useEffect, useRef, useState } from "react";

type MaximizableTextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange"
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  wrapperClassName?: string;
  expandedTitle?: string;
  expandedRows?: number;
};

const MaximizableTextarea = React.forwardRef<HTMLTextAreaElement, MaximizableTextareaProps>(
function MaximizableTextarea({
  value,
  defaultValue = "",
  onValueChange,
  wrapperClassName = "",
  expandedTitle = "Message",
  expandedRows = 18,
  className = "",
  ...props
}, ref) {
  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const expandedRef = useRef<HTMLTextAreaElement>(null);
  const text = isControlled ? value ?? "" : internalValue;

  const updateValue = (next: string) => {
    if (!isControlled) setInternalValue(next);
    onValueChange?.(next);
  };

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const id = window.setTimeout(() => expandedRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(id);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <div className={`relative ${wrapperClassName}`}>
      <textarea
        ref={ref}
        {...props}
        value={text}
        onChange={(event) => updateValue(event.currentTarget.value)}
        className={`${className} pr-10`}
      />
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Maximize text input"
        title="Maximize"
        className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-text-muted)] shadow-sm transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 3h6v6" />
          <path d="m21 3-7 7" />
          <path d="M9 21H3v-6" />
          <path d="m3 21 7-7" />
        </svg>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex h-[min(44rem,90vh)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">
                {expandedTitle}
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close expanded text input"
                className="grid h-8 w-8 place-items-center rounded-lg text-lg leading-none text-[var(--color-text-muted)] transition hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)]"
              >
                &times;
              </button>
            </div>
            <div className="flex min-h-0 flex-1 p-4">
              <textarea
                ref={expandedRef}
                value={text}
                onChange={(event) => updateValue(event.currentTarget.value)}
                onKeyDown={props.onKeyDown}
                rows={expandedRows}
                maxLength={props.maxLength}
                placeholder={props.placeholder}
                className="min-h-0 flex-1 resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-4 py-3 text-sm leading-relaxed text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            <div className="flex justify-end border-t border-[var(--color-line)] px-4 py-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-bg)] transition hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

MaximizableTextarea.displayName = "MaximizableTextarea";

export default MaximizableTextarea;
