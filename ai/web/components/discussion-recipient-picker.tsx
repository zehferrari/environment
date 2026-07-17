"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  actorDisplayName,
  MessageAvatar,
  type MessageActor,
} from "@/components/message-avatar";

export type DiscussionTarget = {
  value: string;
  label: string;
  group: "Groups" | "Users" | "Agents";
  actor?: MessageActor | null;
};

type PickerPosition = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

const GROUPS: DiscussionTarget["group"][] = ["Groups", "Users", "Agents"];

export default function DiscussionRecipientPicker({
  options,
  values,
  onChange,
  open,
  onOpenChange,
}: {
  options: DiscussionTarget[];
  values: string[];
  onChange: (values: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const didAutofocusRef = useRef(false);
  const [position, setPosition] = useState<PickerPosition | null>(null);
  const orderedOptions = useMemo(
    () => GROUPS.flatMap((group) => options.filter((option) => option.group === group)),
    [options],
  );

  const selectedOptions = useMemo(
    () => values
      .map((value) => options.find((option) => option.value === value))
      .filter((option): option is DiscussionTarget => Boolean(option)),
    [options, values],
  );
  const accessibleLabel = selectedOptions.length === 0
    ? "Default recipient"
    : selectedOptions.map((option) => option.label).join(", ");

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 8;
    const gap = 8;
    const width = Math.min(rect.width, viewportWidth - margin * 2);
    const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
    const spaceAbove = rect.top - margin - gap;
    const spaceBelow = viewportHeight - rect.bottom - margin - gap;
    const openUp = spaceAbove >= 240 || spaceAbove > spaceBelow;
    const available = openUp ? spaceAbove : spaceBelow;

    setPosition({
      left,
      width,
      top: openUp ? undefined : rect.bottom + gap,
      bottom: openUp ? viewportHeight - rect.top + gap : undefined,
      maxHeight: Math.max(144, Math.min(360, available)),
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) {
      didAutofocusRef.current = false;
      return;
    }
    if (!position || didAutofocusRef.current) return;
    didAutofocusRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      const selectedIndex = orderedOptions.findIndex((option) => values.includes(option.value));
      optionRefs.current[Math.max(0, selectedIndex)]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, orderedOptions, position, values]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [onOpenChange, open]);

  const toggle = (target: DiscussionTarget) => {
    if (target.group === "Groups") {
      onChange(values.includes(target.value) ? [] : [target.value]);
      return;
    }
    const withoutGroups = values.filter((value) => (
      options.find((option) => option.value === value)?.group !== "Groups"
    ));
    onChange(
      withoutGroups.includes(target.value)
        ? withoutGroups.filter((value) => value !== target.value)
        : [...withoutGroups, target.value],
    );
  };

  const focusOption = (currentIndex: number, direction: -1 | 1) => {
    if (orderedOptions.length === 0) return;
    const next = (currentIndex + direction + orderedOptions.length) % orderedOptions.length;
    optionRefs.current[next]?.focus();
  };

  return (
    <div className="text-caption text-text-muted">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold">To</span>
        {values.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-nano font-semibold uppercase tracking-wider text-text-muted hover:text-accent"
          >
            Clear
          </button>
        ) : null}
      </div>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            onOpenChange(true);
          }
          if (event.key === "Escape") onOpenChange(false);
        }}
        className="flex min-h-10 w-full items-center justify-between gap-3 rounded-card border border-line bg-bg px-3 py-2 text-left text-caption text-text outline-none transition hover:border-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-haspopup="listbox"
        aria-label={`Recipients: ${accessibleLabel}`}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {selectedOptions.length === 0 ? (
            <span className="text-text-muted">Default recipient</span>
          ) : selectedOptions.map((target) => (
            <span
              key={target.value}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-panel px-2 py-1"
            >
              {target.actor ? (
                <MessageAvatar actor={target.actor} size="sm" />
              ) : (
                <span className="grid h-7 w-7 place-items-center rounded-full border border-line text-nano font-semibold">G</span>
              )}
              <span className="max-w-[9rem] truncate">{target.label}</span>
            </span>
          ))}
        </span>
        <span className="shrink-0 text-text-muted" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open && position ? createPortal(
        <div
          ref={panelRef}
          id={listboxId}
          role="listbox"
          aria-label="Message recipients"
          aria-multiselectable="true"
          style={{
            position: "fixed",
            left: position.left,
            width: position.width,
            top: position.top,
            bottom: position.bottom,
            maxHeight: position.maxHeight,
          }}
          className="z-[70] overflow-y-auto rounded-card border border-line bg-panel p-2 shadow-2xl"
          onKeyDown={(event) => {
            const currentIndex = optionRefs.current.findIndex((option) => option === document.activeElement);
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusOption(Math.max(0, currentIndex), 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusOption(currentIndex < 0 ? 0 : currentIndex, -1);
            } else if (event.key === "Home") {
              event.preventDefault();
              optionRefs.current[0]?.focus();
            } else if (event.key === "End") {
              event.preventDefault();
              optionRefs.current[orderedOptions.length - 1]?.focus();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onOpenChange(false);
              triggerRef.current?.focus();
            }
          }}
        >
          {GROUPS.map((group) => {
            const groupedOptions = options.filter((target) => target.group === group);
            if (groupedOptions.length === 0) return null;
            return (
              <div key={group} className="py-1">
                <div className="px-2 pb-1 text-nano font-semibold uppercase tracking-wider text-text-muted">
                  {group}
                </div>
                <div className="space-y-1">
                  {groupedOptions.map((target) => {
                    const optionIndex = orderedOptions.findIndex((option) => option.value === target.value);
                    const selected = values.includes(target.value);
                    return (
                      <button
                        key={target.value}
                        ref={(element) => { optionRefs.current[optionIndex] = element; }}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => toggle(target)}
                        className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition md:min-h-0 ${
                          selected
                            ? "bg-accent/[0.12] text-text"
                            : "text-text-muted hover:bg-panel-soft hover:text-text"
                        }`}
                      >
                        {target.actor ? (
                          <MessageAvatar actor={target.actor} size="sm" />
                        ) : (
                          <span className="grid h-7 w-7 place-items-center rounded-full border border-line text-nano font-semibold">G</span>
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {target.actor ? actorDisplayName(target.actor) : target.label}
                        </span>
                        <span className="text-nano font-semibold uppercase tracking-wider">
                          {selected ? "Selected" : target.group}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
