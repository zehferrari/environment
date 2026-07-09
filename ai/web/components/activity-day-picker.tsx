"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

// Calendar-day filter for the System Activity page. Picking a day pins the
// window to that local calendar day (overriding the rolling-range presets,
// which are plain links rendered by the server). Clearing returns to the
// current preset.
export default function ActivityDayPicker({ day }: { day: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const navigate = (value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("day", value);
    else params.delete("day");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <label className="inline-flex items-center gap-1.5 text-caption text-text-muted">
        <span>Day</span>
        <input
          type="date"
          value={day ?? ""}
          onChange={(e) => navigate(e.target.value || null)}
          className={`rounded-lg border bg-bg px-2 py-1 text-caption text-text outline-none transition focus:border-accent ${
            day ? "border-accent" : "border-line"
          }`}
          aria-label="Filter activity to a specific day"
        />
      </label>
      {day ? (
        <button
          type="button"
          onClick={() => navigate(null)}
          className="rounded-full border border-line px-2 py-0.5 text-nano font-medium text-text-muted transition hover:border-accent hover:text-accent"
        >
          Clear ×
        </button>
      ) : null}
    </span>
  );
}
