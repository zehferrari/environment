const fs = require('fs');
const path = require('path');
const self = require('../agent-self');

const JIRA_URL = 'https://zeh-ferrari.atlassian.net';
const TOKEN_PATH = path.join(process.env.HOME, '.ssh', 'jiraToken.txt');
const USERNAME = self.email;

function getAuth() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Jira token not found at ${TOKEN_PATH}`);
  }
  const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  return Buffer.from(`${USERNAME}:${token}`).toString('base64');
}

function methodOf(options = {}) {
  return String(options.method || 'GET').toUpperCase();
}

function parseBody(options = {}) {
  if (!options.body) return null;
  if (typeof options.body === 'object') return options.body;
  try {
    return JSON.parse(String(options.body));
  } catch {
    return null;
  }
}

function assertAllowedMutation(endpoint, options = {}) {
  const method = methodOf(options);
  const body = parseBody(options);

  if (method === 'PUT' && /^\/issue\/[^/]+\/assignee(?:\?|$)/.test(endpoint)) {
    const targetAccountId = body?.accountId || null;
    if (targetAccountId && self.jiraAccountId && targetAccountId === self.jiraAccountId) {
      throw new Error('Policy guard: agents may not assign Jira tickets to themselves. Ask zeh or use an explicit manager-to-developer handoff.');
    }
  }
}

async function jiraRequest(endpoint, options = {}) {
  assertAllowedMutation(endpoint, options);
  const auth = getAuth();
  const url = `${JIRA_URL}/rest/api/3${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jira API error: ${response.status} - ${error}`);
  }

  if (response.status === 204) {
    return { success: true };
  }

  return response.json();
}

async function jiraSearch(jql, maxResults = 20) {
  const auth = getAuth();
  const url = `${JIRA_URL}/rest/api/3/search/jql`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      jql,
      maxResults,
      fields: ['summary', 'status', 'priority', 'updated', 'assignee']
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jira API error: ${response.status} - ${error}`);
  }

  return response.json();
}

module.exports = { JIRA_URL, getAuth, jiraRequest, jiraSearch };
