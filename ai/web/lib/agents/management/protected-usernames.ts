const SYSTEM_USERNAMES = new Set([
  "root",
  "system",
  "admin",
  "daemon",
  "bin",
  "sys",
  "code-agents",
]);

function configuredUsernames(): Set<string> {
  return new Set(
    (process.env.PM_RESERVED_AGENT_USERNAMES ?? "")
      .split(",")
      .map((username) => username.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isProtectedAgentUsername(username: string): boolean {
  const normalized = username.trim().toLowerCase();
  return SYSTEM_USERNAMES.has(normalized) || configuredUsernames().has(normalized);
}
