#!/usr/bin/env node
//
// jira-receiver.js — Jira webhook entry point for the monitor agent.
//
// One of two split-out services that replace the old monolithic
// webhook-receiver.js. Handles ONLY the Jira side:
//
//   GET  /health  - liveness + routed user list (for the integrity check
//                   and nginx upstream health probes)
//   POST /jira    - Jira Cloud webhook payloads, HMAC-verified via
//                   JIRA_WEBHOOK_SECRET. ADF @-mentions take priority
//                   over assignee — they get routed to the mentioned
//                   agents only, with pending-mention markers written so
//                   ai-monitor can detect missing replies.
//
// Shared logic (signature verify, user resolution, task queueing,
// wake-agent, dashboard notify, pending-mention persistence) lives in
// common.js. Each receiver is just a thin route table over the shared
// library — fewer than ~80 lines apiece.

const c = require('./common');

if (!c.isReceiverEnabled('jira')) {
  console.log('jira-receiver: integrations.jira is false for this agent — exiting cleanly (nothing to do)');
  process.exit(0);
}

const spec = c.KNOWN_RECEIVERS.jira;
const PORT = process.env.PORT || spec.port;
const HOST = process.env.HOST || '127.0.0.1';
const JIRA_SECRET = process.env.JIRA_WEBHOOK_SECRET || '';

const server = c.http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'jira-receiver',
      users: Object.keys(c.config.users),
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/jira') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const signature = req.headers['x-hub-signature'] || '';
        if (!c.verifySignature(body, signature, JIRA_SECRET)) {
          c.sharedLog('Jira webhook: invalid signature');
          res.writeHead(401); res.end('Unauthorized');
          return;
        }

        const event = JSON.parse(body);
        c.sharedLog(`Jira webhook received: ${event.webhookEvent}`);
        c.recordPendingEpicComment(event);

        // Mention-routing wins over assignee — a comment that names
        // specific agents is a more precise signal than the assignee field.
        const mentioned = c.resolveJiraMentionedAgents(event);
        const matchedUsers = c.resolveJiraUsers(event);
        const mentionedUsers = new Set(mentioned.map(m => m.userCfg.username));
        for (const userCfg of matchedUsers) {
          if (!mentionedUsers.has(userCfg.username)) {
            c.recordPendingAssigneeComment(userCfg, event);
          }
        }

        let targetUsers;
        const mentionContextByUser = {};
        if (mentioned.length) {
          targetUsers = mentioned.map(m => m.userCfg);
          const issueKey = event.issue?.key || 'unknown';
          const mentioner = event.comment?.author?.displayName || event.user?.displayName || 'Unknown';
          const preview = c.adfToText(event.comment?.body || {}).slice(0, 240).replace(/\s+/g, ' ').trim();
          for (const m of mentioned) {
            mentionContextByUser[m.userCfg.username] =
              `You were @-mentioned in ${issueKey} by ${mentioner}. ` +
              `TEAM_WORKFLOW.md "Responding to @mentions" applies — you must reply, even if the ticket isn't assigned to you. ` +
              `Comment preview: "${preview}"`;
            c.recordPendingMention(m.userCfg, event);
          }
          c.sharedLog(`Jira webhook: ADF @-mention routes ${issueKey} to ${targetUsers.map(u => u.username).join(',')}`);
        } else if (matchedUsers.length) {
          targetUsers = matchedUsers;
        } else {
          c.sharedLog(`Jira webhook: no explicit assignee or @mention for ${event.issue?.key || 'unknown'}; not queueing unassigned work`);
          res.writeHead(200); res.end('OK');
          return;
        }

        const isDeploymentApproved = Boolean(
          event.changelog?.items?.find(item => item.field === 'status' && item.toString === 'Deployment Approved')
        );

        for (const userCfg of targetUsers) {
          const didQueue = await c.queueJiraTask(userCfg, event);
          if (didQueue && !isDeploymentApproved) {
            const ctx = mentionContextByUser[userCfg.username] || '';
            c.wakeAgent(userCfg, 'webhook-event', ctx);
          }
        }

        res.writeHead(200); res.end('OK');
      } catch (e) {
        c.sharedLog(`Jira webhook error: ${e.message}`);
        res.writeHead(500); res.end('Error');
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`jira-receiver listening on http://${HOST}:${PORT}`);
  console.log(`Users: ${Object.keys(c.config.users).join(', ')}`);
});
