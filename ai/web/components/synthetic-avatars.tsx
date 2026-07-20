// Synthetic (non-owner) identity glyphs. These stand in for masked agent
// actors in member sessions: agents acting as reviewer/acting-manager render
// as "Feedback / Review", and the monitor agent renders as "Monitor". Both
// are inline, monochrome line glyphs drawn in `currentColor` so they adapt to
// the surrounding theme (light + dark) and stay legible at 24-40px. They are
// intentionally cohesive as a set: same 24-unit viewBox, same stroke weight
// and round caps. No photos, no agent slugs/names — nothing that could leak a
// real agent identity to a non-owner.

type GlyphProps = { className?: string };

// Feedback / Review — a speech bubble carrying a check mark: a note that has
// been read and signed off. Evokes review feedback.
export function SyntheticReviewAvatar({ className = "h-full w-full" }: GlyphProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8.4L6 19.2A.5.5 0 0 1 5.2 18.8V16a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      <path d="M8.6 10.2l2.4 2.4 4.4-4.8" />
    </svg>
  );
}

// Monitor — concentric radar arcs radiating from a center point: a watchful
// signal / pulse. Evokes continuous monitoring.
export function SyntheticMonitorAvatar({ className = "h-full w-full" }: GlyphProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <path d="M8.3 15.7a5.2 5.2 0 0 1 0-7.4" />
      <path d="M15.7 8.3a5.2 5.2 0 0 1 0 7.4" />
      <path d="M5.7 18.3a9 9 0 0 1 0-12.6" />
      <path d="M18.3 5.7a9 9 0 0 1 0 12.6" />
    </svg>
  );
}

export type SyntheticKind = "review" | "monitor";

export function SyntheticAvatar({ kind, className }: { kind: SyntheticKind; className?: string }) {
  return kind === "monitor" ? (
    <SyntheticMonitorAvatar className={className} />
  ) : (
    <SyntheticReviewAvatar className={className} />
  );
}
