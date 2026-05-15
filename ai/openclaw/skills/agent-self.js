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
};
