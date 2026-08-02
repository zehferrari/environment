"use client";

import { useId, useState } from "react";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";
import type { BulkTaskRoleField } from "@/lib/tasks/bulk-roles";

export type BulkTaskEditField = "status" | BulkTaskRoleField;

export default function TaskBulkEditControls({
  statusOptions,
  roleOptions = [],
  canManageRoles = false,
  disabled = false,
  onApply,
}: {
  statusOptions: ReadonlyArray<{ value: string; label: string }>;
  roleOptions?: AvatarComboboxOption[];
  canManageRoles?: boolean;
  disabled?: boolean;
  onApply: (field: BulkTaskEditField, value: string | null) => void;
}) {
  const pickerId = useId();
  const [field, setField] = useState<BulkTaskEditField>("status");
  const [value, setValue] = useState(statusOptions.find((option) => option.value === "To Do")?.value ?? statusOptions[0]?.value ?? "");
  const isStatus = field === "status";

  function changeField(next: BulkTaskEditField) {
    setField(next);
    setValue(next === "status"
      ? statusOptions.find((option) => option.value === "To Do")?.value ?? statusOptions[0]?.value ?? ""
      : "");
  }

  const emptyLabel = field === "assigneeId"
    ? "Unassigned"
    : field === "actingManagerId"
      ? "No reviewer"
      : "No reporter";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wider text-text-muted">
        <span>Change</span>
        <select
          value={field}
          onChange={(event) => changeField(event.currentTarget.value as BulkTaskEditField)}
          disabled={disabled}
          aria-label="Bulk task field"
          className="rounded-lg border border-line bg-bg px-2 py-1.5 text-caption normal-case tracking-normal text-text outline-none focus:border-accent disabled:opacity-50"
        >
          <option value="status">Status</option>
          {canManageRoles ? (
            <>
              <option value="assigneeId">Assignee</option>
              <option value="actingManagerId">Reviewer</option>
              <option value="reporterId">Reporter</option>
            </>
          ) : null}
        </select>
      </label>
      <span className="text-caption font-semibold uppercase tracking-wider text-text-muted">to</span>
      {isStatus ? (
        <select
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          disabled={disabled}
          aria-label="Bulk task status"
          className="rounded-lg border border-line bg-bg px-2 py-1.5 text-caption text-text outline-none focus:border-accent disabled:opacity-50"
        >
          {statusOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <div className="min-w-48 max-w-64 normal-case tracking-normal">
          <AvatarCombobox
            key={field}
            formId={`bulk-task-${pickerId}`}
            name={field}
            defaultValue={value}
            options={roleOptions}
            emptyLabel={emptyLabel}
            ariaLabel={`Bulk task ${field}`}
            onChange={setValue}
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => onApply(field, isStatus ? value : value || null)}
        disabled={disabled || (isStatus && !value)}
        className="rounded-lg bg-accent px-control-x py-control-y text-caption font-semibold text-bg transition hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
      >
        Apply
      </button>
    </div>
  );
}
