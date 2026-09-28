// Read side of the "switchable single site" feature. The web app is
// intentionally unprivileged here: it only reads a state file and
// writes a request file under a per-project spool dir. The privileged build +
// service flip is done by the separate worktree switch runner (runs as the
// monitor, decoupled from the served unit). See deploy/MULTI_AGENT_WORKTREES.md.
//
// The spool dir is per-project (resolved from the switch registry by repoKey),
// so multiple projects each get their own switcher state without colliding.

import { readFile } from "node:fs/promises";
import path from "node:path";

// Legacy default spool for deployments that use the PM switcher. Registry
// entries supply their own spool path for all other projects.
export const SWITCH_DIR = process.env.PM_SWITCH_DIR ?? "/var/lib/pm/switch";

export function stateFilePath(spoolDir: string): string {
  return path.join(spoolDir, "state.json");
}

export function requestFilePath(spoolDir: string): string {
  return path.join(spoolDir, "request.json");
}

export type SwitchWorktree = {
  path: string;
  name: string;
  branch: string;
  head: string;
  ready: boolean; // node_modules present -> buildable
  served: boolean;
  needsWorktree?: boolean; // Existing local branch, checkout created on selection.
  canPrepare?: boolean; // Runner can create the checkout/install dependencies.
};

export type SwitchJobState = "idle" | "queued" | "building" | "working" | "done" | "error";

export type SwitchJob = {
  id: string | null;
  state: SwitchJobState;
  action?: string;
  target: string | null;
  message: string;
  startedAt: string | null;
  updatedAt: string;
  log: string;
};

export type SwitchState = {
  /** Worktree root the service is currently serving, or null if off/unknown. */
  served: string | null;
  servedBranch: string | null;
  /**
   * Whether the project's site is currently up. false = the runner has taken
   * it offline ("off"): for node-service the unit is stopped (port freed); for
   * nginx-docroot the maintenance/deny gate is engaged.
   */
  siteActive: boolean;
  worktrees: SwitchWorktree[];
  job: SwitchJob;
  updatedAt: string;
  /** false when the runner / spool isn't installed for this project. */
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

/** Read the runner-maintained state.json for a project's spool dir. Never
 *  throws — a missing file just means the switcher isn't installed for this
 *  project on this host (available: false). */
export async function readSwitchState(
  spoolDir: string = SWITCH_DIR,
): Promise<SwitchState> {
  try {
    const raw = await readFile(stateFilePath(spoolDir), "utf8");
    const s = JSON.parse(raw) as Partial<SwitchState>;
    return {
      served: s.served ?? null,
      servedBranch: s.servedBranch ?? null,
      // Older runners (pre-on/off) don't emit siteActive; treat presence of a
      // served worktree as "on" for backward compatibility.
      siteActive: s.siteActive ?? Boolean(s.served),
      worktrees: Array.isArray(s.worktrees) ? s.worktrees : [],
      job: s.job ?? idleJob(),
      updatedAt: s.updatedAt ?? new Date().toISOString(),
      available: true,
    };
  } catch {
    return {
      served: null,
      servedBranch: null,
      siteActive: false,
      worktrees: [],
      job: idleJob(),
      updatedAt: new Date().toISOString(),
      available: false,
    };
  }
}
