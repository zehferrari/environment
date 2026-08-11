export const SESSION_RECOVERY_PATH = "/api/auth/session-expired";

// Auth.js changes the session-cookie prefix when the public origin is HTTPS
// and splits oversized cookies into numeric chunks. Clear both variants so a
// browser cannot keep presenting an old, validly signed token after the
// server-side session callback has invalidated it (for example after a
// password change or account deactivation).
export const AUTH_SESSION_COOKIE_BASE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
] as const;

export function isAuthSessionCookieName(name: string): boolean {
  return AUTH_SESSION_COOKIE_BASE_NAMES.some((base) => {
    if (name === base) return true;
    if (!name.startsWith(`${base}.`)) return false;
    return /^\d+$/.test(name.slice(base.length + 1));
  });
}
