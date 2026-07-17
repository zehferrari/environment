export const EPIC_BOARD_STATUSES = ["Backlog", "In Progress", "Ready to Deploy", "Done"] as const;

// Keep the default focused on work that is actively moving toward deployment.
export const DEFAULT_EPIC_BOARD_STATUSES = ["In Progress", "Ready to Deploy"] as const;

export function parseEpicBoardStatuses(
  statuses: string | undefined,
  legacyStatus: string | undefined,
) {
  if (!statuses && legacyStatus) {
    const match = EPIC_BOARD_STATUSES.find(
      (status) => status.toLowerCase() === legacyStatus.toLowerCase(),
    );
    if (match) return [match];
  }

  if (statuses === undefined) return [...DEFAULT_EPIC_BOARD_STATUSES];

  const requested = statuses
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return EPIC_BOARD_STATUSES.filter((status) => requested.includes(status.toLowerCase()));
}
