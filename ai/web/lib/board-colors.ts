// Shared colour helpers for the unified workspaces board: workspace border
// colours and project background tints. Kept dependency-free so tests and
// migrations can mirror the same palette.

export const BOARD_COLOR_PALETTE = [
  "#e11d48",
  "#db2777",
  "#9333ea",
  "#7c3aed",
  "#4f46e5",
  "#2563eb",
  "#0891b2",
  "#059669",
  "#16a34a",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
] as const;

export function randomBoardColor(): string {
  return BOARD_COLOR_PALETTE[Math.floor(Math.random() * BOARD_COLOR_PALETTE.length)];
}

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Canonicalizes to lowercase #rrggbb. Returns null for blank input; throws
// on non-blank values that are not a valid hex colour.
export function hexColorOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Colour must be a hex value like #2563eb.");
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (!HEX_COLOR_PATTERN.test(raw)) throw new Error("Colour must be a hex value like #2563eb.");
  if (raw.length === 4) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return raw;
}

// #rrggbb + alpha (0..1) -> #rrggbbaa for translucent backgrounds.
export function hexWithAlpha(hex: string, alpha: number): string {
  const normalized = hexColorOrNull(hex);
  if (!normalized) return "transparent";
  const clamped = Math.max(0, Math.min(1, alpha));
  const byte = Math.round(clamped * 255).toString(16).padStart(2, "0");
  return `${normalized}${byte}`;
}

// Deterministic fallback for rows that predate the colour columns and were
// never backfilled (e.g. created through a raw path); keeps rendering stable.
export function fallbackBoardColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return BOARD_COLOR_PALETTE[hash % BOARD_COLOR_PALETTE.length];
}
