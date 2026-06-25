"use client";

import React, { useEffect, useRef, useState } from "react";
import { Button, Surface, Textarea } from "@/components/ui/primitives";

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
        className={`${className} pr-12`}
      />
      <Button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Maximize text input"
        title="Maximize"
        variant="ghost"
        className="absolute right-2 top-2 h-11 w-11 rounded-md bg-panel p-0 shadow-sm md:h-9 md:w-9"
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
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
      </Button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-card backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <Surface
            elevated
            padding="none"
            className="flex h-[min(44rem,90vh)] w-full max-w-5xl flex-col overflow-hidden"
            onClick={(event: React.MouseEvent) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <h3 className="text-body font-semibold text-text">
                {expandedTitle}
              </h3>
              <Button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close expanded text input"
                variant="icon"
                size="icon"
              >
                &times;
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 p-card">
              <Textarea
                ref={expandedRef}
                value={text}
                onChange={(event) => updateValue(event.currentTarget.value)}
                onKeyDown={props.onKeyDown}
                rows={expandedRows}
                maxLength={props.maxLength}
                placeholder={props.placeholder}
                className="min-h-0 flex-1 rounded-card px-4 py-3 leading-relaxed"
              />
            </div>
            <div className="flex justify-end border-t border-line px-4 py-3">
              <Button type="button" onClick={() => setOpen(false)} variant="primary" size="lg">
                Done
              </Button>
            </div>
          </Surface>
        </div>
      ) : null}
    </div>
  );
});

MaximizableTextarea.displayName = "MaximizableTextarea";

export default MaximizableTextarea;
