// Shared plain-text helpers for turning a markdown chat body into a short,
// human-readable snippet — used for chat/archive summaries, web-push bodies, and
// native notification bodies so the same reply reads the same way everywhere.

// Strip the markdown noise that reads badly in a one-line summary: fenced code
// becomes a "code" marker, inline markdown punctuation is dropped, and runs of
// whitespace collapse to single spaces.
export function stripChatMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/[#*_>`[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Truncate to `max` characters, preferring a word/sentence boundary, with a
// trailing "..." when the text was actually cut.
export function truncateSummary(value: string, max = 72): string {
  if (value.length <= max) return value;
  const sliced = value.slice(0, max - 1).trimEnd();
  const breakAt = Math.max(sliced.lastIndexOf(" "), sliced.lastIndexOf("."));
  return `${(breakAt > 28 ? sliced.slice(0, breakAt) : sliced).trimEnd()}...`;
}
