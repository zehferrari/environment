// Member-view redaction of real agent identities inside free text (comment
// bodies). The actor-visibility projectors mask the AUTHOR avatar/name of an
// agent comment, but the body still renders verbatim — and agents routinely
// name each other ("@asdrubal", "asdrubal will rebase"). For a non-owner
// member the whole point of masking is that individual agents are not exposed,
// so every reference to a real agent slug / username / display name is
// collapsed to a neutral token before render.

export type AgentIdentity = {
  username: string;
  slug?: string | null;
  name?: string | null;
};

const NEUTRAL_MENTION = "@agent";
const NEUTRAL_NAME = "an agent";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a redactor from the full agent registry. Returns identity for the
// owner (maskAgents=false) so the owner sees raw text. Tokens are matched
// longest-first so "asdrubal irwin" is redacted before "asdrubal".
export function buildAgentRedactor(
  agents: readonly AgentIdentity[],
  maskAgents: boolean,
): (body: string) => string {
  if (!maskAgents) return (body) => body;

  const tokens = new Set<string>();
  for (const agent of agents) {
    for (const raw of [agent.username, agent.slug, agent.name]) {
      const t = raw?.trim();
      if (t && t.length >= 2) tokens.add(t);
    }
  }
  if (tokens.size === 0) return (body) => body;

  const ordered = [...tokens].sort((a, b) => b.length - a.length);
  const alternation = ordered.map(escapeRegExp).join("|");
  // @mention form (redact the @ + token together) and bare word form.
  const mentionRe = new RegExp(`@(?:${alternation})\\b`, "gi");
  const bareRe = new RegExp(`\\b(?:${alternation})\\b`, "gi");

  return (body: string) => {
    if (!body) return body;
    return body.replace(mentionRe, NEUTRAL_MENTION).replace(bareRe, NEUTRAL_NAME);
  };
}
