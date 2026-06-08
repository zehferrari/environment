export interface PmOption {
  id: string;
  label: string;
}

export interface ParsedPmOptions {
  body: string;
  options: PmOption[];
}

const TRAILING_PM_OPTIONS_RE = /(?:^|\n)```pm-options\s*\n([\s\S]*?)\n```\s*$/;

function cleanCell(value: string) {
  return value
    .replace(/\\\|/g, "|")
    .replace(/\\n/g, "\n")
    .trim();
}

function slugOption(value: string, fallback: number) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `option-${fallback + 1}`;
}

export function parsePmOptions(input: string): ParsedPmOptions {
  const normalized = input.replace(/\r\n/g, "\n");
  const match = TRAILING_PM_OPTIONS_RE.exec(normalized);
  if (!match) return { body: input, options: [] };

  const options: PmOption[] = [];
  const seen = new Set<string>();

  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    if (!line || /^\|?\s*-{3,}/.test(line)) continue;
    const trimmed = line.replace(/^\|/, "").replace(/\|$/, "");
    const cells = trimmed.split(/(?<!\\)\|/).map(cleanCell).filter(Boolean);
    if (cells.length > 1 && /^id$/i.test(cells[0]) && /^(label|option|text)$/i.test(cells[1])) continue;
    const label = cells.length > 1 && /^id$/i.test(cells[0]) ? cells[1] : cells.at(-1);
    if (!label || label.length > 80) continue;
    const requestedId = cells.length > 1 && !/^id$/i.test(cells[0]) ? cells[0] : "";
    let id = slugOption(requestedId || label, options.length);
    let suffix = 2;
    while (seen.has(id)) id = `${id}-${suffix++}`;
    seen.add(id);
    options.push({ id, label });
  }

  if (options.length === 0 || options.length > 8) return { body: input, options: [] };
  return { body: normalized.slice(0, match.index).trimEnd(), options };
}

export function findPmOptionResolution(
  options: ReadonlyArray<PmOption>,
  laterBodies: ReadonlyArray<string>,
): PmOption | null {
  if (options.length === 0) return null;
  const normalized = new Map(options.map((option) => [option.label.trim().toLowerCase(), option]));
  for (const body of laterBodies) {
    const firstLine = body.trim().split(/\r?\n/, 1)[0]?.trim().toLowerCase();
    if (firstLine && normalized.has(firstLine)) return normalized.get(firstLine)!;
  }
  return null;
}

export function isPmOptionsTargetedAtCurrentUser(args: {
  currentUserId?: string | null;
  targetType?: string | null;
  targetValue?: string | null;
}) {
  if (!args.currentUserId) return false;
  if (!args.targetType || !args.targetValue) return true;
  const userTarget = `user:${args.currentUserId}`;
  if (args.targetType === "user") return args.targetValue === userTarget;
  if (args.targetType === "multi") {
    try {
      const values = JSON.parse(args.targetValue);
      return Array.isArray(values) && values.includes(userTarget);
    } catch {
      return false;
    }
  }
  return false;
}
