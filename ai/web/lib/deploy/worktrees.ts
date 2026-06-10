// Read side of the "switchable single site" feature. The PM web app (runs as
// karen) is intentionally UNPRIVILEGED here: it only reads a state file and
// writes a request file under a shared spool dir. The privileged build +
// `systemctl restart pm.service` is done by the separate `pm-switch-runner`
// service (runs as zeh, decoupled from pm.service). See
// deploy/MULTI_AGENT_WORKTREES.md.

import { readFile } from "node:fs/promises";
import path from "node:path";

export const SWITCH_DIR = process.env.PM_SWITCH_DIR ?? "/var/lib/pm/switch";
export const STATE_FILE = path.join(SWITCH_DIR, "state.json");
export const REQUEST_FILE = path.join(SWITCH_DIR, "request.json");

export type SwitchWorktree = {
  path: string;
  name: string;
  branch: string;
  head: string;
  ready: boolean; // node_modules present -> buildable
  served: boolean;
};

export type SwitchJobState = "idle" | "queued" | "installing" | "building" | "done" | "error";

export type SwitchJob = {
  id: string | null;
  state: SwitchJobState;
  target: string | null;
  message: string;
  startedAt: string | null;
  updatedAt: string;
  log: string;
};

export type SwitchState = {
  /** Worktree root pm.service is currently serving, or null if unknown. */
  served: string | null;
  servedBranch: string | null;
  worktrees: SwitchWorktree[];
  job: SwitchJob;
  updatedAt: string;
  /** false when the runner / spool isn't installed on this host. */
  available: boolean;
};

function idleJob(): SwitchJob {
  return {
    id: null,
    state: "idle",
    target: null,
    message: "",
    startedAt: null,
    updatedAt: new Date().toISOString(),
    log: "",
  };
}

/** Read the runner-maintained state.json. Never throws — a missing file just
 *  means the switcher isn't installed (available: false). */
export async function readSwitchState(): Promise<SwitchState> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const s = JSON.parse(raw) as Partial<SwitchState>;
    return {
      served: s.served ?? null,
      servedBranch: s.servedBranch ?? null,
      worktrees: Array.isArray(s.worktrees) ? s.worktrees : [],
      job: s.job ?? idleJob(),
      updatedAt: s.updatedAt ?? new Date().toISOString(),
      available: true,
    };
  } catch {
    return {
      served: null,
      servedBranch: null,
      worktrees: [],
      job: idleJob(),
      updatedAt: new Date().toISOString(),
      available: false,
    };
  }
}
