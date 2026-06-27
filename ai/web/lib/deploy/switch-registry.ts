// Project switch registry — the single source of truth for which repositories
// expose the live-preview worktree switcher and HOW each one is switched.
//
// One switcher, many projects: the web UI, status route, and request writer all
// resolve a project's particularities from here by its canonical repoKey (the
// repo path with any `.worktrees/<branch>` suffix stripped — see repo-key.ts).
// The host-side runner reads the matching values from its own env file; this
// module is the web-side mirror of that contract.
//
// Pure string/data logic only (no node builtins) so it is safe to import from
// client components, exactly like repo-key.ts.

// How a project is served, and therefore how a switch + on/off behave.
//   node-service  — a managed systemd unit serving a port (Next.js: build →
//                   fork DB → flip WorkingDirectory → restart). on/off =
//                   systemctl start/stop, which genuinely frees the port and
//                   process. PM (environment) and WDT use this.
//   nginx-docroot — nginx + PHP-FPM served from a docroot symlink. switch =
//                   atomically repoint the symlink + reload. on/off = toggle a
//                   maintenance/deny rewrite; it gates ACCESS but cannot free
//                   resources, because PHP-FPM is a shared pool with no
//                   per-project process to stop. Patricia uses this.
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
   * PM lives at `<root>/ai/web`; WDT and Patricia are served from the repo
   * root, so this is "". Used so the generic scripts don't assume `ai/web`.
   */
  appSubdir: string;
  /**
   * Whether "off" actually frees resources (stops a process/port). True for
   * node-service. False for nginx-docroot, where "off" is an access gate only.
   * Surfaced in the UI so the control is honest about what it does.
   */
  offFreesResources: boolean;
  /**
   * Whether this project's spool is served by a runner that understands the
   * on/off lifecycle (worktree-switch-runner). False for `environment`, which
   * still runs on the legacy pm-switch-runner that ignores action:off|on — so
   * the UI hides the on/off control there rather than expose a misleading
   * production switch, until the supervised PM migration (WS6) moves it onto
   * the templated runner.
   */
  lifecycleControl: boolean;
};

// Registry, keyed by canonical repoKey. Adding a project = one entry here plus
// a matching host runner env file (/etc/worktree-preview/<key>.env). PM keeps
// its existing /var/lib/pm/switch spool so the live board is zero-touch until
// the supervised PM migration; new projects use the uniform layout.
const PROJECTS: SwitchProject[] = [
  {
    key: "environment",
    repoKey: "/srv/Code/environment",
    worktreesRoot: "/srv/Code/environment.worktrees",
    spoolDir: "/var/lib/pm/switch",
    driver: "node-service",
    appSubdir: "ai/web",
    offFreesResources: true,
    // Legacy pm-switch-runner — no on/off support yet (see WS6 migration).
    lifecycleControl: false,
  },
  {
    key: "wdt",
    repoKey: "/srv/Code/whitsunday-discovery-trail",
    worktreesRoot: "/srv/Code/whitsunday-discovery-trail.worktrees",
    spoolDir: "/var/lib/worktree-switch/wdt",
    driver: "node-service",
    appSubdir: "",
    offFreesResources: true,
    lifecycleControl: true,
  },
  {
    key: "patricia",
    repoKey: "/srv/Code/patricia",
    worktreesRoot: "/srv/Code/patricia.worktrees",
    spoolDir: "/var/lib/worktree-switch/patricia",
    driver: "nginx-docroot",
    appSubdir: "",
    offFreesResources: false,
    lifecycleControl: true,
  },
];

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
