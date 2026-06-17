// Canonicalizes an inbound PM session key into the agent-scoped store form
// `agent:<agentId>:<rest>`.
//
// Why this lives here: the web app emits route-local/bare PM keys
// (`pm:<type>:<id>:agent:<slug>`) and the gateway inbound path records the
// supplied routeSessionKey verbatim — nothing on the PM inbound path applies
// the `agent:<id>:` namespace. The runtime's own canonicalizer
// (toAgentStoreSessionKey, plugin-sdk routing/session-key.ts) is not on the
// public plugin-sdk export surface, so this mirrors its logic with the same
// double-prefix guards. PM keys carry no opaque signal-group peer segments,
// so plain lowercase normalization matches the runtime's observable output.

const DEFAULT_AGENT_ID = "main";
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

/**
 * @param {string | undefined | null} value
 * @returns {string}
 */
function normalizeAgentId(value) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_AGENT_ID;
  const normalized = trimmed.toLowerCase();
  if (VALID_ID_RE.test(trimmed)) return normalized;
  return (
    normalized
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

/**
 * Mirror of the runtime parseAgentSessionKey: an `agent:<agentId>:<rest>` key
 * with a non-empty agentId and rest. Lowercased to match runtime normalization.
 * @param {string | undefined | null} sessionKey
 * @returns {{ agentId: string, rest: string } | null}
 */
function parseAgentSessionKey(sessionKey) {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) return null;
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3) return null;
  if (parts[0] !== "agent") return null;
  const agentId = parts[1].trim();
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) return null;
  return { agentId, rest };
}

/**
 * Wrap a supplied PM session key into the canonical agent-scoped store key.
 * Idempotent: already-scoped (`agent:<id>:…`) keys are not double-prefixed.
 * @param {{ agentId: string, requestKey: string | undefined | null }} params
 * @returns {string}
 */
export function canonicalizePmStoreSessionKey({ agentId, requestKey }) {
  const raw = (requestKey ?? "").trim();
  const lowered = raw.toLowerCase();
  if (!raw || lowered === "main") {
    return `agent:${normalizeAgentId(agentId)}:main`;
  }
  const parsed = parseAgentSessionKey(raw);
  if (parsed) return `agent:${parsed.agentId}:${parsed.rest}`;
  // Malformed `agent:` prefix that does not parse — leave as-is rather than
  // stacking another `agent:<id>:` in front of it.
  if (lowered.startsWith("agent:")) return lowered;
  return `agent:${normalizeAgentId(agentId)}:${lowered}`;
}
