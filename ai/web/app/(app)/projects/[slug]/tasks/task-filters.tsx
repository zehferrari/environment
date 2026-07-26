"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";

const PAGE_SIZES = ["10", "25", "50", "100", "all"] as const;

// The Tasks filter bar, self-applying: any control change (select or people
// combobox) navigates immediately, so there is no Apply button — it mirrors
// epic-filters.tsx. Selects are keyed by their live value so they re-mount
// consistently after each navigation; the people comboboxes keep their own
// open/selection state and only reset when Clear bumps `resetKey`.
export default function TaskFilters({
  slug,
  isOwner,
  view,
  reporterIds,
  assigneeIds,
  reviewerIds,
  status,
  pageSize,
  statusOptions,
  options,
}: {
  slug: string;
  isOwner: boolean;
  view: string;
  reporterIds: string[];
  assigneeIds: string[];
  reviewerIds: string[];
  status: string;
  pageSize: string;
  statusOptions: readonly string[];
  options: AvatarComboboxOption[];
}) {
  const router = useRouter();
  const [resetKey, setResetKey] = useState(0);
  const base = {
    view,
    reporterId: reporterIds,
    assigneeId: assigneeIds,
    reviewerId: reviewerIds,
    status,
    pageSize,
  };

  function push(next: typeof base) {
    const params = new URLSearchParams();
    if (next.view && next.view !== "board") params.set("view", next.view);
    next.reporterId.forEach((v) => params.append("reporterId", v));
    next.assigneeId.forEach((v) => params.append("assigneeId", v));
    next.reviewerId.forEach((v) => params.append("reviewerId", v));
    if (next.status) params.set("status", next.status);
    if (next.pageSize && next.pageSize !== "25") params.set("pageSize", next.pageSize);
    const qs = params.toString();
    router.push(`/projects/${slug}/tasks${qs ? `?${qs}` : ""}`);
  }

  return (
    <div
      className={`grid gap-3 rounded-card border border-line bg-panel p-3 text-body ${isOwner ? "md:grid-cols-3 xl:grid-cols-[repeat(6,minmax(0,1fr))_auto]" : "md:grid-cols-2 xl:grid-cols-[repeat(3,minmax(0,1fr))_auto]"}`}
    >
      <Select label="View" value={view} onChange={(v) => push({ ...base, view: v })}>
        <option value="all">All</option>
        <option value="board">Board</option>
        <option value="archive">Archive</option>
      </Select>
      {isOwner ? (
        <Field label="Reporter">
          <AvatarCombobox
            key={`rep-${resetKey}`}
            formId="taskFilters"
            name="reporterId"
            multiple
            defaultValues={reporterIds}
            options={options}
            emptyLabel="All reporters"
            ariaLabel="Reporter filter"
            onChangeMultiple={(vals) => push({ ...base, reporterId: vals })}
          />
        </Field>
      ) : null}
      {isOwner ? (
        <Field label="Assignee">
          <AvatarCombobox
            key={`asg-${resetKey}`}
            formId="taskFilters"
            name="assigneeId"
            multiple
            defaultValues={assigneeIds}
            options={options}
            emptyLabel="All assignees"
            ariaLabel="Assignee filter"
            onChangeMultiple={(vals) => push({ ...base, assigneeId: vals })}
          />
        </Field>
      ) : null}
      {isOwner ? (
        <Field label="Reviewer">
          <AvatarCombobox
            key={`rev-${resetKey}`}
            formId="taskFilters"
            name="reviewerId"
            multiple
            defaultValues={reviewerIds}
            options={options}
            emptyLabel="All reviewers"
            ariaLabel="Reviewer filter"
            onChangeMultiple={(vals) => push({ ...base, reviewerId: vals })}
          />
        </Field>
      ) : null}
      <Select label="Status" value={status} onChange={(v) => push({ ...base, status: v })}>
        <option value="">All statuses</option>
        {statusOptions.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </Select>
      <Select label="Rows" value={pageSize} onChange={(v) => push({ ...base, pageSize: v })}>
        {PAGE_SIZES.map((size) => (
          <option key={size} value={size}>
            {size === "all" ? "All" : size}
          </option>
        ))}
      </Select>
      <div className="flex items-end">
        <button
          type="button"
          onClick={() => {
            setResetKey((k) => k + 1);
            router.push(`/projects/${slug}/tasks${view !== "board" ? `?view=${view}` : ""}`);
          }}
          className="grid h-9 place-items-center rounded-lg bg-accent px-3 text-caption font-semibold text-bg hover:opacity-90"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <select
        key={`${label}-${value}`}
        defaultValue={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-9 w-full rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent"
      >
        {children}
      </select>
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block">
      <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </span>
      {children}
    </div>
  );
}
