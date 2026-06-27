"use client";

import { useMemo, useState } from "react";

type Props = {
  name: string;
  defaultBranches?: string[];
  options?: string[];
  disabled?: boolean;
  inputClassName?: string;
};

function normalize(value: string) {
  return value.trim();
}

function unique(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const branch = normalize(value);
    if (!branch) continue;
    const key = branch.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(branch);
  }
  return out;
}

export default function BranchMultiCombobox({
  name,
  defaultBranches = [],
  options = [],
  disabled = false,
  inputClassName = "w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent",
}: Props) {
  const [branches, setBranches] = useState(() => unique(defaultBranches));
  const [draft, setDraft] = useState("");
  const datalistId = `${name}-options`;
  const visibleOptions = useMemo(() => unique([...options, ...branches]), [options, branches]);

  const add = (value: string) => {
    if (disabled) return;
    const branch = normalize(value);
    if (!branch) return;
    setBranches((current) => unique([...current, branch]));
    setDraft("");
  };

  return (
    <div className="space-y-2">
      {branches.map((branch) => (
        <input key={branch} type="hidden" name={name} value={branch} />
      ))}
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          list={datalistId}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add(draft);
            }
          }}
          placeholder="main, production, release/stable"
          className={inputClassName}
        />
        <button
          type="button"
          disabled={disabled || !draft.trim()}
          onClick={() => add(draft)}
          className="rounded-lg border border-line px-3 py-control-y text-body font-medium hover:bg-panel disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <datalist id={datalistId}>
        {visibleOptions.map((branch) => (
          <option key={branch} value={branch} />
        ))}
      </datalist>
      {branches.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {branches.map((branch) => (
            <span key={branch} className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-caption font-mono">
              {branch}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${branch}`}
                  onClick={() => setBranches((current) => current.filter((item) => item !== branch))}
                  className="text-text-muted hover:text-danger"
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-caption text-text-muted">No protected branches configured.</p>
      )}
    </div>
  );
}
