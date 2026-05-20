#!/usr/bin/env node
//
// bitbucket-receiver.js — Bitbucket webhook entry point for the monitor agent.
//
// One of two split-out services that replace the old monolithic
// webhook-receiver.js. Handles ONLY the Bitbucket side:
//
//   GET  /health     - liveness + routed user list (integrity check / nginx)
//   POST /bitbucket  - Bitbucket Cloud webhook payloads, HMAC-verified via
//                      BITBUCKET_WEBHOOK_SECRET. Routes by actor displayName/
//                      username/nickname; if no actor maps to a known user,
//                      broadcasts to all routed users.
//
// Shared logic in common.js.

const c = require('./common');

if (!c.isReceiverEnabled('bitbucket')) {
  console.log('bitbucket-receiver: integrations.bitbucket is false for this agent — exiting cleanly (nothing to do)');
  process.exit(0);
}

const spec = c.KNOWN_RECEIVERS.bitbucket;
const PORT = process.env.PORT || spec.port;
const HOST = process.env.HOST || '127.0.0.1';
const BITBUCKET_SECRET = process.env.BITBUCKET_WEBHOOK_SECRET || '';

const server = c.http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'bitbucket-receiver',
      users: Object.keys(c.config.users),
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/bitbucket') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const signature = req.headers['x-hub-signature'] || '';
        if (!c.verifySignature(body, signature, BITBUCKET_SECRET)) {
          c.sharedLog('Bitbucket webhook: invalid signature');
          res.writeHead(401); res.end('Unauthorized');
          return;
        }

        const event = JSON.parse(body);
        const changesCount = event.push?.changes?.length || 0;
        c.sharedLog(`Bitbucket webhook received: ${changesCount} changes`);

        if (changesCount <= 0) {
          res.writeHead(200); res.end('OK');
          return;
        }

        const matchedUsers = c.resolveBitbucketUsers(event);
        const targetUsers = matchedUsers.length ? matchedUsers : Object.values(c.allUsers);

        if (!matchedUsers.length) {
          c.sharedLog(`Bitbucket webhook: no explicit user match for actor ${event.actor?.displayName || event.actor?.username || 'unknown'}; broadcasting to all users`);
        }

        for (const userCfg of targetUsers) {
          const didQueue = c.queueBitbucketTask(userCfg, event);
          if (didQueue) c.wakeAgent(userCfg);
        }

        res.writeHead(200); res.end('OK');
      } catch (e) {
        c.sharedLog(`Bitbucket webhook error: ${e.message}`);
        res.writeHead(500); res.end('Error');
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`bitbucket-receiver listening on http://${HOST}:${PORT}`);
  console.log(`Users: ${Object.keys(c.config.users).join(', ')}`);
});
