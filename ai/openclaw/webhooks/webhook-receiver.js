#!/usr/bin/env node

/**
 * Multi-tenant webhook receiver for Jira and Bitbucket
 * Routes events to the correct user based on Jira assignee / Bitbucket actor
 * Listens on a single port and dispatches to per-user task files
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = process.env.PORT || 3010;
const HOST = process.env.HOST || '127.0.0.1';
const SHARED_LOG = '/home/karen/tasks/log.md';

// Webhook secrets (shared across all users — one Atlassian workspace)
const JIRA_SECRET = process.env.JIRA_WEBHOOK_SECRET || '';
const BITBUCKET_SECRET = process.env.BITBUCKET_WEBHOOK_SECRET || '';
const OPENCLAW_CONTROL_BIN = '/usr/local/sbin/openclaw-control';
const CONTROL_ALLOWED_USERS = new Set(['asdrubal', 'barekbaal']);
const REGISTRY_PATH = process.env.OPENCLAW_AGENTS_JSON || '/etc/openclaw/agents.json';

const DASHBOARD_HOST = '127.0.0.1';
const DASHBOARD_PORT = 3013;
function notifyDashboard(user, key) {
  // Fire-and-forget hint to agent-dashboard so it re-polls Jira for this user
  // immediately. Errors are swallowed — the dashboard's own poll covers misses.
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


// Load user config
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8')
);

function loadRegistryByUser() {
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return Object.fromEntries((registry.agents || []).map(agent => [agent.user, agent]));
  } catch (_e) {
    return {};
  }
}

const registryByUser = loadRegistryByUser();

// Build lookup: Jira display name -> user config, accountId -> user config
const jiraNameToUser = {};
const jiraAccountIdToUser = {};
const allUsers = {};
for (const [username, userCfg] of Object.entries(config.users)) {
  userCfg.username = username;
  const registryAgent = registryByUser[username] || {};
  userCfg.role = registryAgent.role || userCfg.role || 'developer';
  userCfg.capabilities = registryAgent.capabilities || userCfg.capabilities || {};
  userCfg.integrations = registryAgent.integrations || userCfg.integrations || {};
  allUsers[username] = userCfg;
  jiraNameToUser[userCfg.jiraDisplayName] = userCfg;
  if (userCfg.jiraAccountId) {
    jiraAccountIdToUser[userCfg.jiraAccountId] = userCfg;
  }
}

// Pending-mentions queue: ai-monitor reads this dir to detect "@-mentioned but
// no agent reply" stalls. Path mirrors decisions/ which is also written by karen
// and read by root.
const PENDING_MENTIONS_DIR = '/var/lib/ai-monitor/pending-mentions';
try { fs.mkdirSync(PENDING_MENTIONS_DIR, { recursive: true }); } catch (_e) {}

// Walk an Atlassian Document Format tree and collect every {type:"mention"} node.
// Returns [{accountId, text}].
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

// Wiki-markup mention syntax used by Jira Cloud webhook payloads (which usually
// send comment.body as a string, NOT as an ADF object): [~accountid:712020:...]
// or the legacy [~username] form. accountId is unambiguous; username is not, so
// we only return accountId-form matches.
function extractWikiMentions(bodyStr) {
  const found = [];
  if (typeof bodyStr !== 'string' || !bodyStr) return found;
  const re = /\[~accountid:([^\]\s]+)\]/g;
  let m;
  while ((m = re.exec(bodyStr)) !== null) {
    found.push({ accountId: m[1], text: '' });
  }
  return found;
}

// Render an ADF body to plain text for wake-context previews. Also passes
// through wiki-markup string bodies (webhook format) unchanged.
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

// For comment_created/comment_updated events, return [{userCfg, mentionText}]
// for every known agent @-mentioned in the comment body, EXCLUDING the comment
// author (no self-wake).
function resolveJiraMentionedAgents(event) {
  const wh = String(event.webhookEvent || '');
  if (!wh.startsWith('comment_')) return [];
  const body = event.comment?.body;
  if (!body) return [];
  const authorAccountId = event.comment?.author?.accountId;
  // Webhook payloads send body as ADF object OR wiki-markup string depending on
  // Jira config. Try both — whichever matches first wins.
  const mentions = (typeof body === 'string')
    ? extractWikiMentions(body)
    : extractAdfMentions(body);
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

// Persist a pending-mention marker so ai-monitor can fire a stall alert if the
// agent doesn't reply within the configured window. Idempotent: same key+commentId
// overwrites the existing entry.
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

function sharedLog(message) {
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} — ${message}\n`;
  fs.appendFileSync(SHARED_LOG, logLine);
  console.log(`[${timestamp}] ${message}`);
}

function userLog(userCfg, message) {
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} — ${message}\n`;
  fs.appendFileSync(userCfg.logFile, logLine);
  sharedLog(`[${userCfg.username}] ${message}`);
}

function verifySignature(payload, signature, secret) {
  if (!secret) return true;
  if (!signature) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// Resolve which users a Jira event belongs to
function resolveJiraUsers(event) {
  const matches = [];
  const seen = new Set();

  const addByName = (name) => {
    if (!name) return;
    const userCfg = jiraNameToUser[name];
    if (!userCfg) return;
    if (seen.has(userCfg.username)) return;
    seen.add(userCfg.username);
    matches.push(userCfg);
  };

  // Primary: current assignee
  addByName(event.issue?.fields?.assignee?.displayName);

  // Assignment change: route to new assignee and prior assignee (for handoff context)
  const assigneeChange = (event.changelog?.items || []).find(i => i.field === 'assignee');
  addByName(assigneeChange?.toString);
  addByName(assigneeChange?.fromString);

  return matches;
}

// Resolve which users a Bitbucket event belongs to
function resolveBitbucketUsers(event) {
  const matches = [];
  const seen = new Set();

  const addByName = (name) => {
    if (!name) return;
    const userCfg = jiraNameToUser[name];
    if (!userCfg) return;
    if (seen.has(userCfg.username)) return;
    seen.add(userCfg.username);
    matches.push(userCfg);
  };

  addByName(event.actor?.displayName);
  addByName(event.actor?.username);
  addByName(event.actor?.nickname);

  return matches;
}

async function queueJiraTask(userCfg, event) {
  const issueKey = event.issue?.key;
  const issueSummary = event.issue?.fields?.summary || '';
  const webhookEvent = event.webhookEvent || '';
  const user = event.user?.displayName || 'Unknown';
  const status = event.issue?.fields?.status?.name || '';
  const changelog = event.changelog?.items || [];

  if (!issueKey) {
    userLog(userCfg, 'Jira webhook: no issue key found, skipping');
    return false;
  }

  if (String(status).toLowerCase() === 'backlog') {
    userLog(userCfg, `Jira webhook: ignored ${issueKey} because status is Backlog`);
    return false;
  }

  const assigneeChange = changelog.find(item => item.field === 'assignee');
  const isAssignedToUser = assigneeChange && assigneeChange.toString === userCfg.jiraDisplayName;

  const statusChange = changelog.find(item => item.field === 'status');
  const isDeploymentApproved = statusChange && statusChange.toString === 'Deployment Approved';

  const timestamp = new Date().toISOString();

  // Ignore self-generated events
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

  // Assignment to this user — wake immediately
  if (isAssignedToUser) {
    const isManager = userCfg.role === 'manager';
    const nextSteps = isManager
      ? [
          '- [ ] Check why this manager-role agent was assigned',
          '- [ ] Do not move to In Progress, modify code, push, or create a PR',
          '- [ ] Triage, review, delegate to the developer, or ask zeh for clarification'
        ]
      : [
          '- [ ] Check assignee and source of assignment',
          '- [ ] Move ticket to "In Progress"',
          '- [ ] Start executing work'
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
- ${timestamp} — Action required: ${isManager ? 'manager triage/review only; no implementation or PR' : 'start work immediately'}

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

  // Deployment Approved — auto-execute
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

  // Generic Jira event
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

function runOpenClawControl(args) {
  execFileSync('sudo', ['-n', OPENCLAW_CONTROL_BIN, ...args], { stdio: 'ignore' });
}

function restartOpenClawServices(userCfg, reason = 'webhook-event') {
  if (!CONTROL_ALLOWED_USERS.has(userCfg.username)) {
    userLog(userCfg, `Skipping OpenClaw service restart for unsupported user: ${userCfg.username}`);
    return false;
  }

  try {
    runOpenClawControl(['restart-services', userCfg.username, reason]);
    userLog(userCfg, `OpenClaw services restarted (${reason})`);
    return true;
  } catch (e) {
    userLog(userCfg, `Failed to restart OpenClaw services: ${e.message}`);
    return false;
  }
}

function wakeAgent(userCfg, reason = 'webhook-event', extraContext = '') {
  if (!CONTROL_ALLOWED_USERS.has(userCfg.username)) {
    userLog(userCfg, `Skipping agent wake for unsupported user: ${userCfg.username}`);
    return false;
  }

  const prefix = extraContext ? `${extraContext}\n\n` : '';
  const rolePolicy = userCfg.role === 'manager'
    ? 'You are the manager role: do not self-assign, do not move implementation tickets to In Progress, do not modify code, do not push branches, and do not create PRs. Triage, review, delegate to the developer, or ask zeh for clarification.'
    : 'You are the developer role: only start implementation when the ticket is assigned to you by zeh or the manager and is not blocked.';
  const text = `${prefix}New Jira webhook event received (${reason}). Process ${userCfg.tasksFile} now. ${rolePolicy} Send exactly one concise Telegram start notice to zeh if this creates actionable work, then keep all task communication in Jira. Do not send Telegram progress, completion, or blocker messages for this Jira task unless zeh explicitly redirects the conversation. Fill Next steps and follow SOUL.md, ROLES.md, and TEAM_WORKFLOW.md. Sign every outbound Jira comment/update with the current runtime model using the Outbound Signature Rule. Update ${userCfg.logFile}.`;

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

async function autoCreatePR(userCfg, issueKey, issueSummary) {
  const token = fs.readFileSync(userCfg.bitbucketTokenFile, 'utf8').trim();
  const auth = Buffer.from(`${userCfg.bitbucketEmail}:${token}`).toString('base64');

  async function findBranchForIssue(issueKey) {
    return new Promise((resolve) => {
      const q = encodeURIComponent(`name~"${issueKey}"`);
      const options = {
        hostname: 'api.bitbucket.org',
        path: `/2.0/repositories/${config.bitbucketWorkspace}/${config.bitbucketRepo}/refs/branches?q=${q}&pagelen=50`,
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json'
        }
      };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            const values = data.values || [];
            const key = String(issueKey || '').toLowerCase();
            const candidates = values
              .map((b) => ({ name: b.name, date: b.target?.date ? new Date(b.target.date).getTime() : 0 }))
              .filter((b) => b.name && !['main', 'master', 'develop'].includes(String(b.name).toLowerCase()))
              .filter((b) => String(b.name).toLowerCase().includes(key));
            if (!candidates.length) return resolve(null);
            const starts = candidates.filter((b) => String(b.name).toLowerCase().startsWith(key));
            const pool = starts.length ? starts : candidates;
            pool.sort((a, b) => (b.date || 0) - (a.date || 0));
            resolve(pool[0].name);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  const branchName = (await findBranchForIssue(issueKey)) || `${issueKey.toLowerCase()}-deployment`;

  const data = JSON.stringify({
    title: `${issueKey} ${issueSummary}`,
    description: `Auto-created PR for ${issueKey}\n\nJira: https://${config.jiraHost}/browse/${issueKey}`,
    source: { branch: { name: branchName } },
    destination: { branch: { name: 'main' } }
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.bitbucket.org',
      path: `/2.0/repositories/${config.bitbucketWorkspace}/${config.bitbucketRepo}/pullrequests`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const result = JSON.parse(body);
        if (res.statusCode === 201) {
          userLog(userCfg, `Auto-created PR for ${issueKey}: ${result.links?.html?.href}`);
          resolve(result);
        } else {
          userLog(userCfg, `Failed to create PR: ${result.error?.message}`);
          reject(new Error(result.error?.message));
        }
      });
    });
    req.on('error', (e) => { userLog(userCfg, `PR creation error: ${e.message}`); reject(e); });
    req.write(data);
    req.end();
  });
}

async function autoTransitionToInReview(userCfg, issueKey) {
  const token = fs.readFileSync(userCfg.jiraTokenFile, 'utf8').trim();

  const transitions = await new Promise((resolve, reject) => {
    const options = {
      hostname: config.jiraHost,
      path: `/rest/api/3/issue/${issueKey}/transitions`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });

  const inReviewTransition = transitions.transitions?.find(t =>
    t.name === 'In Review' || t.to?.name === 'In Review'
  );

  if (!inReviewTransition) {
    userLog(userCfg, `No "In Review" transition found for ${issueKey}`);
    return;
  }

  const data = JSON.stringify({ transition: { id: inReviewTransition.id } });

  await new Promise((resolve, reject) => {
    const options = {
      hostname: config.jiraHost,
      path: `/rest/api/3/issue/${issueKey}/transitions`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };
    const req = https.request(options, (res) => {
      if (res.statusCode === 204) {
        userLog(userCfg, `Auto-transitioned ${issueKey} to In Review`);
        resolve();
      } else {
        reject(new Error(`Transition failed: ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      users: Object.keys(config.users),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Jira webhook
  if (req.method === 'POST' && url.pathname === '/jira') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const signature = req.headers['x-hub-signature'] || '';
        if (!verifySignature(body, signature, JIRA_SECRET)) {
          sharedLog('Jira webhook: invalid signature');
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }

        const event = JSON.parse(body);
        sharedLog(`Jira webhook received: ${event.webhookEvent}`);

        // Preferred: route by ADF @-mentions in comment body. If a comment names
        // specific agents, those are the only users we should wake — the mention
        // is a more precise signal than assignee/reporter.
        const mentioned = resolveJiraMentionedAgents(event);
        const matchedUsers = resolveJiraUsers(event);

        let targetUsers;
        let mentionContextByUser = {};
        if (mentioned.length) {
          targetUsers = mentioned.map(m => m.userCfg);
          const issueKey = event.issue?.key || 'unknown';
          const mentioner = event.comment?.author?.displayName || event.user?.displayName || 'Unknown';
          const preview = adfToText(event.comment?.body || {}).slice(0, 240).replace(/\s+/g, ' ').trim();
          for (const m of mentioned) {
            mentionContextByUser[m.userCfg.username] =
              `You were @-mentioned in ${issueKey} by ${mentioner}. ` +
              `TEAM_WORKFLOW.md "Responding to @mentions" applies — you must reply, even if the ticket isn't assigned to you. ` +
              `Comment preview: "${preview}"`;
            recordPendingMention(m.userCfg, event);
          }
          sharedLog(`Jira webhook: ADF @-mention routes ${issueKey} to ${targetUsers.map(u => u.username).join(',')}`);
        } else if (matchedUsers.length) {
          targetUsers = matchedUsers;
        } else {
          sharedLog(`Jira webhook: no explicit assignee or @mention for ${event.issue?.key || 'unknown'}; not queueing unassigned work`);
          res.writeHead(200);
          res.end('OK');
          return;
        }

        const isDeploymentApproved = Boolean(
          event.changelog?.items?.find(item => item.field === 'status' && item.toString === 'Deployment Approved')
        );

        for (const userCfg of targetUsers) {
          const didQueue = await queueJiraTask(userCfg, event);
          if (didQueue && !isDeploymentApproved) {
            const ctx = mentionContextByUser[userCfg.username] || '';
            wakeAgent(userCfg, 'webhook-event', ctx);
          }
        }

        res.writeHead(200);
        res.end('OK');
      } catch (e) {
        sharedLog(`Jira webhook error: ${e.message}`);
        res.writeHead(500);
        res.end('Error');
      }
    });
    return;
  }

  // Bitbucket webhook
  if (req.method === 'POST' && url.pathname === '/bitbucket') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const signature = req.headers['x-hub-signature'] || '';
        if (!verifySignature(body, signature, BITBUCKET_SECRET)) {
          sharedLog('Bitbucket webhook: invalid signature');
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }

        const event = JSON.parse(body);
        const changesCount = event.push?.changes?.length || 0;
        sharedLog(`Bitbucket webhook received: ${changesCount} changes`);

        if (changesCount <= 0) {
          res.writeHead(200);
          res.end('OK');
          return;
        }

        const matchedUsers = resolveBitbucketUsers(event);
        const targetUsers = matchedUsers.length ? matchedUsers : Object.values(allUsers);

        if (!matchedUsers.length) {
          sharedLog(`Bitbucket webhook: no explicit user match for actor ${event.actor?.displayName || event.actor?.username || 'unknown'}; broadcasting to all users`);
        }

        for (const userCfg of targetUsers) {
          const didQueue = queueBitbucketTask(userCfg, event);
          if (didQueue) wakeAgent(userCfg);
        }

        res.writeHead(200);
        res.end('OK');
      } catch (e) {
        sharedLog(`Bitbucket webhook error: ${e.message}`);
        res.writeHead(500);
        res.end('Error');
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Multi-tenant webhook receiver listening on http://${HOST}:${PORT}`);
  console.log(`Users: ${Object.keys(config.users).join(', ')}`);
  console.log('Endpoints:');
  console.log('  GET  /health     - Health check');
  console.log('  POST /jira       - Jira webhooks');
  console.log('  POST /bitbucket  - Bitbucket webhooks');
});
