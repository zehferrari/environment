// Project switch registry — the single source of truth for which repositories
// expose the live-preview worktree switcher and HOW each one is switched.
//
// One switcher, many projects: the web UI, status route, and request writer all
// resolve a project's particularities from here by its canonical repoKey (the
// repo path with any `.worktrees/<branch>` suffix stripped — see repo-key.ts).
// The host-side runner reads the matching values from its own env file; this
// module is the web-side mirror of that contract.
//
// The registry is supplied by the deployment through
// PM_WORKTREE_PREVIEW_REGISTRY. Keeping it out of source code prevents one
// installation's repository paths and services from leaking into another.

// How a project is served, and therefore how a switch + on/off behave.
//   node-service  — a managed systemd unit serving a port (build → fork DB →
//                   flip WorkingDirectory → restart). on/off = systemctl
//                   start/stop, which genuinely frees the port and process.
//   nginx-docroot — nginx + PHP-FPM served from a docroot symlink. switch =
//                   atomically repoint the symlink + reload. on/off = toggle a
//                   maintenance/deny rewrite; it gates ACCESS but cannot free
//                   resources, because PHP-FPM is a shared pool with no
//                   per-project process to stop.
export type SwitchDriver = "node-service" | "nginx-docroot";

export type SwitchProject = {
  /** Stable key; also names the spool dir and the worktree-preview@<key> unit. */
  key: string;
  /** Canonical repo path = worktreeRepoKey(project.repositoryPath). */
  repoKey: string;
  /** Where this repo's linked worktrees live (`<repo>.worktrees`). */
  worktreesRoot: string;
  /** Spool dir the runner reads/writes (state.json + request.json). */
  spoolDir: string;
  driver: SwitchDriver;
  /**
   * Sub-path from the worktree root to the buildable/served app dir.
   * Some applications live below the repository root while others are served
   * from it. Used so the generic scripts do not assume a layout.
   */
  appSubdir: string;
  /**
   * Whether "off" actually frees resources (stops a process/port). True for
   * node-service. False for nginx-docroot, where "off" is an access gate only.
   * Surfaced in the UI so the control is honest about what it does.
   */
  offFreesResources: boolean;
  /**
   * Whether each branch deployment serves its OWN database (forked once from
   * the canonical seed by the switch scripts, so schema and data can drift
   * between branches) or all worktrees share one database. Mirrors the host
   * env contract: DB_ENGINE=sqlite → per-branch fork; DB_ENGINE=none → the
   * switcher never touches a DB, so every branch serves the same configured
   * database. Drives the honest copy in the switcher UI.
   */
  branchDatabases: boolean;
  /**
   * Whether this project's spool is served by a runner that understands the
   * on/off lifecycle (worktree-switch-runner). Set false for runners that do
   * not implement on/off so the UI never exposes a misleading control.
   */
  lifecycleControl: boolean;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseProject(value: unknown): SwitchProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const key = nonEmptyString(entry.key);
  const repoKey = nonEmptyString(entry.repoKey);
  const worktreesRoot = nonEmptyString(entry.worktreesRoot);
  const spoolDir = nonEmptyString(entry.spoolDir);
  const appSubdir = typeof entry.appSubdir === "string" ? entry.appSubdir.trim() : null;
  const driver = entry.driver;
  if (!key || !repoKey || !worktreesRoot || !spoolDir || appSubdir === null) return null;
  if (driver !== "node-service" && driver !== "nginx-docroot") return null;
  if (
    typeof entry.offFreesResources !== "boolean" ||
    typeof entry.branchDatabases !== "boolean" ||
    typeof entry.lifecycleControl !== "boolean"
  ) return null;
  return {
    key,
    repoKey: repoKey.replace(/\/+$/, ""),
    worktreesRoot,
    spoolDir,
    driver,
    appSubdir,
    offFreesResources: entry.offFreesResources,
    branchDatabases: entry.branchDatabases,
    lifecycleControl: entry.lifecycleControl,
  };
}

export function parseSwitchProjectRegistry(raw = process.env.PM_WORKTREE_PREVIEW_REGISTRY): SwitchProject[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const byRepoKey = new Map<string, SwitchProject>();
    for (const item of parsed) {
      const project = parseProject(item);
      if (project) byRepoKey.set(project.repoKey, project);
    }
    return [...byRepoKey.values()];
  } catch {
    return [];
  }
}

const PROJECTS = parseSwitchProjectRegistry();

const BY_REPO_KEY = new Map(PROJECTS.map((p) => [p.repoKey, p]));

/** Look up the switch config for a project by its canonical repoKey. */
export function getSwitchProject(repoKey: string | null | undefined): SwitchProject | null {
  if (!repoKey) return null;
  return BY_REPO_KEY.get(repoKey.replace(/\/+$/, "")) ?? null;
}

/** True when this repo is wired into the worktree switcher. */
export function isSwitchableRepo(repoKey: string | null | undefined): boolean {
  return getSwitchProject(repoKey) !== null;
}
