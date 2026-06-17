export function sanitizeBranchComponent(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 180);
}

export function deriveEpicBranchName(epic: { id: string; title: string }) {
  const title = sanitizeBranchComponent(epic.title) || "epic";
  return `${epic.id.toLowerCase()}-${title}`;
}

export function effectiveEpicBranchName(epic: { id: string; title: string; branchName: string | null }) {
  const existing = epic.branchName?.trim();
  return existing || deriveEpicBranchName(epic);
}
