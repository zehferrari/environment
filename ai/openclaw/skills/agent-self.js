// Resolve the running agent's identity from /etc/openclaw/agents.json.
// Shared skill helpers depend on this so they don't hardcode agent-specific
// constants — agent identity flows from the registry by os.userInfo().username.

const fs = require('fs');
const os = require('os');

const REGISTRY_PATH = process.env.OPENCLAW_AGENTS_JSON || '/etc/openclaw/agents.json';

const username = os.userInfo().username;
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const agent = (registry.agents || []).find(a => a.user === username);
if (!agent) {
  throw new Error(`agents.json (${REGISTRY_PATH}): no agent registered for user "${username}"`);
}

const firstName = (agent.name || '').split(/\s+/)[0] || username;

// Canonical RFC 5322 mailbox for the running agent — used as the From:
// header on every outbound email (Gmail send + local-mail sendmail).
// Per TEAM_WORKFLOW.md > "Email sender header (mandatory)": always
// "Name <email>", never bare address. Throws if either field is
// missing in the registry so the agent surfaces the problem instead
// of silently sending without a display name.
function fromHeader() {
  if (!agent.name || !agent.email) {
    throw new Error(
      `agent-self: cannot build From header — missing name (${agent.name || 'unset'}) or email (${agent.email || 'unset'}) for user "${username}" in ${REGISTRY_PATH}`
    );
  }
  return `${agent.name} <${agent.email}>`;
}

module.exports = {
  user: agent.user,
  name: agent.name,
  firstName,
  email: agent.email,
  home: agent.home,
  workspace: agent.workspace,
  jiraAccountId: agent.jira_account_id || null,
  registry,
  agent,
  fromHeader,
};
