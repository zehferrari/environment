export type BoardChromeSlot = "summary" | "controls";

export function boardChromeSlotId(scope: string, slot: BoardChromeSlot) {
  return `workflow-board-${scope}-${slot}`;
}

export function boardStickyTop({
  toolbarHeight,
  toolbarMargin,
  obstructionStickyTop = 0,
  obstructionHeight = 0,
  obstructionMargin = 0,
}: {
  toolbarHeight: number;
  toolbarMargin: number;
  obstructionStickyTop?: number;
  obstructionHeight?: number;
  obstructionMargin?: number;
}) {
  const toolbarFloor = toolbarHeight + toolbarMargin;
  const obstructionFloor = obstructionHeight > 0
    ? obstructionStickyTop + obstructionHeight + obstructionMargin
    : 0;
  return Math.max(toolbarFloor, obstructionFloor);
}

export function boardAvailableHeight({
  viewportHeight,
  columnsTop,
  toolbarHeight,
  toolbarBottom,
  toolbarMargin,
  obstructionStickyTop = 0,
  obstructionHeight = 0,
  obstructionBottom = 0,
  obstructionMargin = 0,
  bottomGap = 16,
}: {
  viewportHeight: number;
  columnsTop: number;
  toolbarHeight: number;
  toolbarBottom: number;
  toolbarMargin: number;
  obstructionStickyTop?: number;
  obstructionHeight?: number;
  obstructionBottom?: number;
  obstructionMargin?: number;
  bottomGap?: number;
}) {
  const currentToolbarFloor = toolbarBottom + toolbarMargin;
  const currentObstructionFloor = obstructionHeight > 0
    ? obstructionBottom + obstructionMargin
    : 0;
  const eventualFloor = boardStickyTop({
    toolbarHeight,
    toolbarMargin,
    obstructionStickyTop,
    obstructionHeight,
    obstructionMargin,
  });
  const effectiveTop = Math.max(
    eventualFloor,
    columnsTop,
    currentToolbarFloor,
    currentObstructionFloor,
  );
  const maximumAvailable = Math.max(
    0,
    viewportHeight - eventualFloor - bottomGap,
  );
  return Math.floor(Math.min(
    maximumAvailable,
    Math.max(0, viewportHeight - effectiveTop - bottomGap),
  ));
}
