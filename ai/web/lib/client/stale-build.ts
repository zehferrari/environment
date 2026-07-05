const RELOAD_MARKER_KEY = "pm:stale-build-reload:v1";
const RELOAD_GUARD_MS = 60_000;
const SUCCESS_CLEAR_DELAY_MS = 10_000;

type ReloadMarker = {
  href: string;
  at: number;
  reason: string;
};

function reasonText(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object") {
    const maybeMessage = "message" in reason ? reason.message : undefined;
    const maybeName = "name" in reason ? reason.name : undefined;
    if (typeof maybeMessage === "string") {
      return typeof maybeName === "string"
        ? `${maybeName}: ${maybeMessage}`
        : maybeMessage;
    }
  }
  return "";
}

export function isLikelyStaleBuildError(reason: unknown): boolean {
  const text = reasonText(reason);
  if (!text) return false;

  return /ChunkLoadError|CSS_CHUNK_LOAD_FAILED|Loading chunk \S+ failed|Loading CSS chunk \S+ failed|failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|\/_next\/static\//i.test(text);
}

function readMarker(storage: Storage): ReloadMarker | null {
  const raw = storage.getItem(RELOAD_MARKER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReloadMarker>;
    if (
      typeof parsed.href === "string"
      && typeof parsed.at === "number"
      && typeof parsed.reason === "string"
    ) {
      return parsed as ReloadMarker;
    }
  } catch {
    // Ignore malformed old markers.
  }
  return null;
}

function writeMarker(storage: Storage, marker: ReloadMarker) {
  storage.setItem(RELOAD_MARKER_KEY, JSON.stringify(marker));
}

export function requestStaleBuildReload(reason: unknown): boolean {
  if (typeof window === "undefined") return false;

  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }

  const href = window.location.href;
  const now = Date.now();
  const marker = storage ? readMarker(storage) : null;
  if (marker && marker.href === href && now - marker.at < RELOAD_GUARD_MS) {
    return false;
  }

  if (storage) {
    writeMarker(storage, {
      href,
      at: now,
      reason: reasonText(reason).slice(0, 240),
    });
  }

  console.warn("[pm] stale client build detected; reloading page", reason);
  window.location.reload();
  return true;
}

export function clearStaleBuildReloadMarker() {
  if (typeof window === "undefined") return;

  window.setTimeout(() => {
    let storage: Storage;
    try {
      storage = window.sessionStorage;
    } catch {
      return;
    }

    const marker = readMarker(storage);
    if (!marker) return;
    if (marker.href === window.location.href) {
      storage.removeItem(RELOAD_MARKER_KEY);
    }
  }, SUCCESS_CLEAR_DELAY_MS);
}
