import type { WorkflowErrorCode } from "@/lib/workflow";

/**
 * Browser status-move response contract. The status mutation itself lives in
 * the canonical browser command adapter; this module intentionally contains
 * no workflow writer or generic status-move shortcut.
 */
export type MoveTaskResult =
  | { ok: true }
  | {
      ok: false;
      code: WorkflowErrorCode | "UNKNOWN_COLUMN" | "STALE_VERSION";
      message: string;
    };

/**
 * Retained while the board client removes its old two-step override prompt.
 * Every authenticated human move now uses the authoritative override command,
 * so this flag cannot select a legacy mutation path.
 */
export type MoveTaskOptions = {
  operatorOverride?: boolean;
};
