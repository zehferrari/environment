"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type EpicOption = {
  id: string;
  title: string;
  status: string;
};

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export default function TaskEpicPicker({
  formId,
  name,
  projectSlug,
  defaultValue,
  epics,
}: {
  formId: string;
  name: string;
  projectSlug: string;
  defaultValue: string;
  epics: EpicOption[];
}) {
  const [selectedEpicId, setSelectedEpicId] = useState(defaultValue);
  const selectedEpic = useMemo(
    () => epics.find((epic) => epic.id === selectedEpicId) ?? null,
    [epics, selectedEpicId],
  );

  return (
    <div className="flex items-center gap-1.5">
      <select
        form={formId}
        name={name}
        value={selectedEpicId}
        onChange={(event) => setSelectedEpicId(event.currentTarget.value)}
        className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent"
        aria-label="Epic"
      >
        <option value="">No epic</option>
        {epics.map((epic) => (
          <option key={epic.id} value={epic.id}>
            {epic.title}
            {epic.status !== "In Progress" ? ` · ${epic.status}` : ""}
          </option>
        ))}
      </select>
      {selectedEpic ? (
        <Link
          href={`/projects/${projectSlug}/epics/${selectedEpic.id}`}
          aria-label={`Epic ${selectedEpic.title}`}
          title={`Epic: ${selectedEpic.title}`}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-soft text-text-muted transition hover:border-accent hover:text-accent"
        >
          <SearchIcon />
        </Link>
      ) : null}
    </div>
  );
}
