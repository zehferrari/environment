// common.js — shared logic for the per-integration webhook receivers
// (jira-receiver.js + bitbucket-receiver.js). Loaded by both; runs as the
// monitor agent (resolved at runtime from /etc/openclaw/agents.json by
// role=monitor — no hardcoded user names).
//
// Exports: createReceiver(opts) returning { server, sharedLog, userLog,
// verifySignature, allUsers, jiraNameToUser, jiraAccountIdToUser, config,
// queueJiraTask, queueBitbucketTask, resolveJiraUsers, resolveBitbucketUsers,
// resolveJiraMentionedAgents, recordPendingMention, adfToText, wakeAgent,
// notifyDashboard }. Each receiver wires its own /health + integration route.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REGISTRY_PATH = process.env.OPENCLAW_AGENTS_JSON || '/etc/openclaw/agents.json';
const OPENCLAW_CONTROL_BIN = '/usr/local/sbin/openclaw-control';

const DASHBOARD_HOST = '127.0.0.1';
const DASHBOARD_PORT = 3013;

// Run as the monitor agent — their home holds the users.json route table
// and the shared log file lives at ~/tasks/log.md. os.homedir() is the
// HOME env (set by the systemd User= directive).
const MONITOR_HOME = os.homedir();
const USERS_JSON = path.join(MONITOR_HOME, 'webhooks', 'users.json');
const SHARED_LOG = path.join(MONITOR_HOME, 'tasks', 'log.md');

const PENDING_MENTIONS_DIR = '/var/lib/ai-monitor/pending-mentions';
const PENDING_ASSIGNEE_COMMENTS_DIR = '/var/lib/ai-monitor/pending-assignee-comments';
const PENDING_EPIC_COMMENTS_DIR = '/var/lib/ai-monitor/pending-epic-comments';
try { fs.mkdirSync(PENDING_MENTIONS_DIR, { recursive: true }); } catch (_e) {}
try { fs.mkdirSync(PENDING_ASSIGNEE_COMMENTS_DIR, { recursive: true }); } catch (_e) {}
try { fs.mkdirSync(PENDING_EPIC_COMMENTS_DIR, { recursive: true }); } catch (_e) {}

// ─── config + registry ──────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(USERS_JSON, 'utf8'));

function loadRegistryByUser() {
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return Object.fromEntries((registry.agents || []).map(a => [a.user, a]));
  } catch (_e) {
    return {};
  }
}

const registryByUser = loadRegistryByUser();

// CONTROL_ALLOWED_USERS is derived from the registry — any agent with
// role=coding may be woken/restarted by this receiver. Previously hardcoded.
const CONTROL_ALLOWED_USERS = new Set(
  Object.values(registryByUser)
    .filter(a => a.role === 'coding' && a.enabled !== false)
    .map(a => a.user)
);

const jiraNameToUser = {};
const jiraAccountIdToUser = {};
const allUsers = {};
for (const [username, userCfg] of Object.entries(config.users)) {
  userCfg.username = username;
  const agent = registryByUser[username] || {};
  userCfg.role = agent.role || userCfg.role || 'developer';
  userCfg.capabilities = agent.capabilities || userCfg.capabilities || {};
  userCfg.integrations = agent.integrations || userCfg.integrations || {};
  allUsers[username] = userCfg;
  jiraNameToUser[userCfg.jiraDisplayName] = userCfg;
  if (userCfg.jiraAccountId) jiraAccountIdToUser[userCfg.jiraAccountId] = userCfg;
}

// ─── logging ────────────────────────────────────────────────────────────────

function sharedLog(message) {
  const ts = new Date().toISOString();
  fs.appendFileSync(SHARED_LOG, `${ts} — ${message}\n`);
  console.log(`[${ts}] ${message}`);
}

function userLog(userCfg, message) {
  const ts = new Date().toISOString();
  fs.appendFileSync(userCfg.logFile, `${ts} — ${message}\n`);
  sharedLog(`[${userCfg.username}] ${message}`);
}

// ─── signature ──────────────────────────────────────────────────────────────

function verifySignature(payload, signature, secret) {
  if (!secret) return true;
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── ADF / wiki-markup mention parsing ──────────────────────────────────────

function extractAdfMentions(adfNode) {
  const found = [];
  const visit = (n) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (typeof n !== 'object') return;
    if (n.type === 'mention') {
      const a = n.attrs || {};
      if (a.id) found.push({ accountId: a.id, text: a.text || '' });
    }
    if (Array.isArray(n.content)) n.content.forEach(visit);
  };
  visit(adfNode);
  return found;
}

function extractWikiMentions(bodyStr) {
  const found = [];
  if (typeof bodyStr !== 'string' || !bodyStr) return found;
  const re = /\[~accountid:([^\]\s]+)\]/g;
  let m;
  while ((m = re.exec(bodyStr)) !== null) found.push({ accountId: m[1], text: '' });
  return found;
}

function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (typeof node !== 'object') return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'mention') {
    const a = node.attrs || {};
    return `@${a.text || a.id || ''}`;
  }
  if (node.type === 'hardBreak' || node.type === 'paragraph') {
    return (Array.isArray(node.content) ? node.content.map(adfToText).join('') : '') + '\n';
  }
  return Array.isArray(node.content) ? node.content.map(adfToText).join('') : '';
}

function resolveJiraMentionedAgents(event) {
  const wh = String(event.webhookEvent || '');
  if (!wh.startsWith('comment_')) return [];
  const body = event.comment?.body;
  if (!body) return [];
  const authorAccountId = event.comment?.author?.accountId;
  const mentions = (typeof body === 'string') ? extractWikiMentions(body) : extractAdfMentions(body);
  const seen = new Set();
  const out = [];
  for (const m of mentions) {
    if (!m.accountId || m.accountId === authorAccountId) continue;
    const userCfg = jiraAccountIdToUser[m.accountId];
    if (!userCfg) continue;
    if (seen.has(userCfg.username)) continue;
    seen.add(userCfg.username);
    out.push({ userCfg, mentionText: m.text });
  }
  return out;
}

function recordPendingMention(userCfg, event) {
  try {
    const issueKey = event.issue?.key;
    const commentId = event.comment?.id;
    if (!issueKey || !commentId) return;
    const fname = `${issueKey}-${commentId}-${userCfg.username}.json`;
    const fpath = path.join(PENDING_MENTIONS_DIR, fname);
    const payload = {
      agent: userCfg.username,
      jira_account_id: userCfg.jiraAccountId,
      issue_key: issueKey,
      comment_id: String(commentId),
      comment_created: event.comment?.created || new Date().toISOString(),
      mentioner_name: event.comment?.author?.displayName || event.user?.displayName || 'Unknown',
      mentioner_account_id: event.comment?.author?.accountId || null,
      preview: adfToText(event.comment?.body || {}).slice(0, 240).replace(/\s+/g, ' ').trim(),
      recorded_at: new Date().toISOString(),
    };
    fs.writeFileSync(fpath, JSON.stringify(payload, null, 2));
    userLog(userCfg, `Pending-mention recorded: ${issueKey} comment=${commentId}`);
  } catch (e) {
    sharedLog(`recordPendingMention failed: ${e.message}`);
  }
}

function recordPendingAssigneeComment(userCfg, event) {
  try {
    const wh = String(event.webhookEvent || '');
    if (wh !== 'comment_created') return;
    const issueKey = event.issue?.key;
    const commentId = event.comment?.id;
    const authorAccountId = event.comment?.author?.accountId || event.user?.accountId;
    if (!issueKey || !commentId || !userCfg?.username) return;
    if (authorAccountId && userCfg.jiraAccountId && authorAccountId === userCfg.jiraAccountId) return;
    const fname = `${issueKey}-${commentId}-${userCfg.username}.json`;
    const fpath = path.join(PENDING_ASSIGNEE_COMMENTS_DIR, fname);
    const payload = {
      agent: userCfg.username,
      jira_account_id: userCfg.jiraAccountId,
      issue_key: issueKey,
      issue_summary: event.issue?.fields?.summary || '',
      comment_id: String(commentId),
      comment_created: event.comment?.created || new Date().toISOString(),
      commenter_name: event.comment?.author?.displayName || event.user?.displayName || 'Unknown',
      commenter_account_id: authorAccountId || null,
      preview: adfToText(event.comment?.body || {}).slice(0, 240).replace(/\s+/g, ' ').trim(),
      recorded_at: new Date().toISOString(),
    };
    fs.writeFileSync(fpath, JSON.stringify(payload, null, 2));
    userLog(userCfg, `Pending assignee-comment review recorded: ${issueKey} comment=${commentId}`);
  } catch (e) {
    sharedLog(`recordPendingAssigneeComment failed: ${e.message}`);
  }
}

function recordPendingEpicComment(event) {
  try {
    const wh = String(event.webhookEvent || '');
    if (wh !== 'comment_created') return;
    const issueKey = event.issue?.key;
    const commentId = event.comment?.id;
    const authorAccountId = event.comment?.author?.accountId || event.user?.accountId;
    if (!issueKey || !commentId || !authorAccountId) return;
    const authorCfg = jiraAccountIdToUser[authorAccountId];
    if (!authorCfg) return;
    const fname = `${issueKey}-${commentId}-${authorCfg.username}.json`;
    const fpath = path.join(PENDING_EPIC_COMMENTS_DIR, fname);
    const payload = {
      author_agent: authorCfg.username,
      author_name: event.comment?.author?.displayName || event.user?.displayName || authorCfg.jiraDisplayName || authorCfg.username,
      author_account_id: authorAccountId,
      issue_key: issueKey,
      issue_summary: event.issue?.fields?.summary || '',
      comment_id: String(commentId),
      comment_created: event.comment?.created || new Date().toISOString(),
      preview: adfToText(event.comment?.body || {}).slice(0, 240).replace(/\s+/g, ' ').trim(),
      recorded_at: new Date().toISOString(),
    };
    fs.writeFileSync(fpath, JSON.stringify(payload, null, 2));
    userLog(authorCfg, `Pending Epic-owner review recorded: ${issueKey} comment=${commentId}`);
  } catch (e) {
    sharedLog(`recordPendingEpicComment failed: ${e.message}`);
  }
}

// ─── user resolution ────────────────────────────────────────────────────────

function resolveJiraUsers(event) {
  const matches = [];
  const seen = new Set();
  const addByName = (name) => {
    if (!name) return;
    const userCfg = jiraNameToUser[name];
    if (!userCfg || seen.has(userCfg.username)) return;
    seen.add(userCfg.username);
    matches.push(userCfg);
  };
  addByName(event.issue?.fields?.assignee?.displayName);
  const assigneeChange = (event.changelog?.items || []).find(i => i.field === 'assignee');
  addByName(assigneeChange?.toString);
  addByName(assigneeChange?.fromString);
  return matches;
}

function resolveBitbucketUsers(event) {
  const matches = [];
  const seen = new Set();
  const addByName = (name) => {
    if (!name) return;
    const userCfg = jiraNameToUser[name];
    if (!userCfg || seen.has(userCfg.username)) return;
    seen.add(userCfg.username);
    matches.push(userCfg);
  };
  addByName(event.actor?.displayName);
  addByName(event.actor?.username);
  addByName(event.actor?.nickname);
  return matches;
}

// ─── task file appenders ────────────────────────────────────────────────────

async function queueJiraTask(userCfg, event) {
  const issueKey = event.issue?.key;
  const issueSummary = event.issue?.fields?.summary || '';
  const webhookEvent = event.webhookEvent || '';
  const user = event.user?.displayName || 'Unknown';
  const status = event.issue?.fields?.status?.name || '';
  const changelog = event.changelog?.items || [];

  if (!issueKey) { userLog(userCfg, 'Jira webhook: no issue key found, skipping'); return false; }
  if (String(status).toLowerCase() === 'backlog') {
    userLog(userCfg, `Jira webhook: ignored ${issueKey} because status is Backlog`);
    return false;
  }

  const assigneeChange = changelog.find(item => item.field === 'assignee');
  const isAssignedToUser = assigneeChange && assigneeChange.toString === userCfg.jiraDisplayName;
  const statusChange = changelog.find(item => item.field === 'status');
  const isDeploymentApproved = statusChange && statusChange.toString === 'Deployment Approved';
  const timestamp = new Date().toISOString();
  const isSelfUser = user === userCfg.jiraDisplayName;
  const isSelfComment = event.comment?.author?.displayName === userCfg.jiraDisplayName;

  if (isAssignedToUser && isSelfUser) {
    userLog(userCfg, `Jira webhook: ignored self-assignment for ${issueKey}; agents may not assign tickets to themselves`);
    return false;
  }
  if (
    (String(webhookEvent || '').startsWith('comment_') && isSelfComment) ||
    (webhookEvent === 'jira:issue_updated' && isSelfUser && !isAssignedToUser && !isDeploymentApproved)
  ) {
    userLog(userCfg, `Jira webhook: ignored self-generated event for ${issueKey} (${webhookEvent})`);
    return false;
  }

  if (isAssignedToUser) {
    const nextSteps = [
      '- [ ] Check assignee and source of assignment',
      '- [ ] Confirm this was not self-assigned',
      '- [ ] Determine the task role from Jira/Epic context, not persona',
      '- [ ] If assignment is valid, start work; do not create a PR'
    ];
    const entry = `
---
## [JIRA Webhook] ${issueKey}: ${issueSummary} 🔔 ASSIGNED TO ME
Source: Jira Webhook (${webhookEvent})
Received: ${timestamp}
Status: QUEUED

### Next steps
${nextSteps.join('\n')}

### Progress log
- ${timestamp} — Assigned to me by ${assigneeChange?.fromString || 'unknown'}
- ${timestamp} — Action required: start only if assignment is valid; PR creation is forbidden

### Webhook payload
\`\`\`json
${JSON.stringify(event, null, 2).substring(0, 1000)}...
\`\`\`
`;
    fs.appendFileSync(userCfg.tasksFile, entry);
    userLog(userCfg, `🔔 ASSIGNED TO ME: ${issueKey} - ${issueSummary}`);
    notifyDashboard(userCfg.username, issueKey);
    return true;
  }

  if (isDeploymentApproved) {
    userLog(userCfg, `Deployment Approved received for ${issueKey}; auto PR creation is disabled by policy`);
    const entry = `
---
## [JIRA Webhook] ${issueKey}: ${issueSummary} — Deployment Approved
Source: Jira Webhook (${webhookEvent})
Received: ${timestamp}
Status: QUEUED

### Next steps
- [ ] Check live Jira and repository state
- [ ] Do not auto-create a PR from the webhook receiver
- [ ] Follow the role policy in ROLES.md and TEAM_WORKFLOW.md

### Progress log
- ${timestamp} — Status changed to Deployment Approved (by ${user})
- ${timestamp} — Auto PR creation disabled; queued for policy-compliant handling
`;
    fs.appendFileSync(userCfg.tasksFile, entry);
    notifyDashboard(userCfg.username, issueKey);
    return true;
  }

  const entry = `
---
## [JIRA Webhook] ${issueKey}: ${issueSummary}
Source: Jira Webhook (${webhookEvent})
Received: ${timestamp}
Status: QUEUED

### Next steps
- [ ] (fill in)

### Progress log
- ${timestamp} — received from Jira webhook (by ${user})

### Webhook payload
\`\`\`json
${JSON.stringify(event, null, 2).substring(0, 1000)}...
\`\`\`
`;
  fs.appendFileSync(userCfg.tasksFile, entry);
  userLog(userCfg, `Queued Jira task: ${issueKey} - ${issueSummary}`);
  notifyDashboard(userCfg.username, issueKey);
  return true;
}

function queueBitbucketTask(userCfg, event) {
  const repo = event.repository?.name || 'unknown';
  const actor = event.actor?.displayName || 'Unknown';
  const push = event.push || {};
  const changes = push.changes || [];
  const timestamp = new Date().toISOString();

  const summaries = changes.map(c => {
    const type = c.new?.type || c.old?.type || 'unknown';
    const name = c.new?.name || c.old?.name || c.new?.target?.hash || c.old?.target?.hash || 'unknown';
    return { type, name };
  });

  const hasMeaningful = summaries.some(s => s.name && s.name !== 'unknown');
  if (!hasMeaningful) {
    userLog(userCfg, `Bitbucket webhook: ignoring unparseable changes for ${repo}`);
    return false;
  }

  const changesDesc = summaries.map(s => `${s.type}: ${s.name}`).join(', ');

  const entry = `
---
## [Bitbucket Webhook] ${repo}
Source: Bitbucket Webhook (push)
Received: ${timestamp}
Status: QUEUED

### Next steps
- [ ] (fill in)

### Progress log
- ${timestamp} — received from Bitbucket webhook (by ${actor})

### Changes
${changesDesc}
`;
  fs.appendFileSync(userCfg.tasksFile, entry);
  userLog(userCfg, `Queued Bitbucket task: ${repo} - ${changesDesc}`);
  return true;
}

// ─── wake / openclaw-control ────────────────────────────────────────────────

function runOpenClawControl(args) {
  execFileSync('sudo', ['-n', OPENCLAW_CONTROL_BIN, ...args], { stdio: 'ignore' });
}

function wakeAgent(userCfg, reason = 'webhook-event', extraContext = '') {
  if (!CONTROL_ALLOWED_USERS.has(userCfg.username)) {
    userLog(userCfg, `Skipping agent wake for unsupported user: ${userCfg.username}`);
    return false;
  }
  const prefix = extraContext ? `${extraContext}\n\n` : '';
  const rolePolicy = 'You are a coding agent, not a standing manager/developer persona. Determine the task role from live Jira/Epic context and explicit assignment. Do not self-assign. Start implementation only when assigned by zeh or a valid handoff. Do not create PRs.';
  const text = `${prefix}New webhook event received (${reason}). Process ${userCfg.tasksFile} now. ${rolePolicy} Send exactly one concise Telegram start notice to zeh if this creates actionable work, then keep all task communication in Jira. Do not send Telegram progress, completion, or blocker messages for this Jira task unless zeh explicitly redirects the conversation. Fill Next steps and follow SOUL.md, ROLES.md, and TEAM_WORKFLOW.md. Sign every outbound Jira comment/update with the current runtime model using the Outbound Signature Rule. Update ${userCfg.logFile}.`;

  try {
    runOpenClawControl(['wake-agent', userCfg.username, text]);
    userLog(userCfg, 'Agent wake triggered');
    return true;
  } catch (e) {
    userLog(userCfg, `Wake failed (${e.message}); attempting restart-and-wake`);
    try {
      runOpenClawControl(['restart-and-wake', userCfg.username, text]);
      userLog(userCfg, 'Agent wake triggered after restart');
      return true;
    } catch (e2) {
      userLog(userCfg, `Failed to wake agent after restart: ${e2.message}`);
      return false;
    }
  }
}

// ─── dashboard hint ─────────────────────────────────────────────────────────

function notifyDashboard(user, key) {
  try {
    const body = JSON.stringify({ user, key });
    const req = http.request({
      hostname: DASHBOARD_HOST, port: DASHBOARD_PORT,
      path: '/internal/jira-event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); });
    req.on('error', () => {});
    req.write(body); req.end();
  } catch (_e) { /* ignore */ }
}

// ─── manifest of possible receivers ─────────────────────────────────────────
//
// Single source of truth for the webhook receivers the monitor agent can
// run. Adding a new integration means: drop a new entry here, write a thin
// entry-point script that imports common and reads KNOWN_RECEIVERS[name],
// register the matching agent-defaults.json byIntegration.<name>.services
// entry, and (per host) point nginx at the new port. Each receiver script
// gates on isReceiverEnabled(name) at startup — disabled integrations
// exit 0 and systemd's Restart=on-failure leaves them stopped.
const KNOWN_RECEIVERS = {
  jira: {
    integration: 'jira',
    port: 3014,
    route: '/jira',
    description: 'Inbound Jira Cloud webhooks (issue updates, comments, assignments). Routes by @-mention then assignee.',
  },
  bitbucket: {
    integration: 'bitbucket',
    port: 3015,
    route: '/bitbucket',
    description: 'Inbound Bitbucket Cloud webhooks (push events). Routes by actor; broadcasts to all users if actor unmatched.',
  },
};

// Resolve the running user's integrations from the registry and check
// whether the named receiver is enabled. Receivers gated on integrations
// the monitor agent has turned off exit cleanly at startup.
function isReceiverEnabled(name) {
  const spec = KNOWN_RECEIVERS[name];
  if (!spec) return false;
  const me = registryByUser[require('os').userInfo().username] || {};
  return Boolean((me.integrations || {})[spec.integration]);
}

// ─── exports ────────────────────────────────────────────────────────────────

module.exports = {
  http, sharedLog, userLog, verifySignature,
  config, allUsers, jiraNameToUser, jiraAccountIdToUser,
  resolveJiraUsers, resolveBitbucketUsers, resolveJiraMentionedAgents,
  recordPendingMention, recordPendingAssigneeComment, recordPendingEpicComment, queueJiraTask, queueBitbucketTask,
  wakeAgent, notifyDashboard, adfToText,
  KNOWN_RECEIVERS, isReceiverEnabled,
};
