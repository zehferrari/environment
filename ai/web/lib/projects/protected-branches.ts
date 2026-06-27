const BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;

export function normalizeBranchName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const branch = value.trim();
  if (!branch) return null;
  if (!BRANCH_RE.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
    throw new Error("Protected branches may only contain letters, numbers, dot, underscore, slash, and hyphen.");
  }
  return branch;
}

export function normalizeBranchList(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeBranchName(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function parseProtectedBranches(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? normalizeBranchList(parsed) : [];
  } catch {
    return [];
  }
}

export function serializeProtectedBranches(values: unknown[]): string | null {
  const branches = normalizeBranchList(values);
  return branches.length > 0 ? JSON.stringify(branches) : null;
}

export function isProtectedBranch(rawList: string | null | undefined, branchName: string | null | undefined) {
  let branch: string | null;
  try {
    branch = normalizeBranchName(branchName);
  } catch {
    return false;
  }
  if (!branch) return false;
  const key = branch.toLowerCase();
  return parseProtectedBranches(rawList).some((item) => item.toLowerCase() === key);
}
