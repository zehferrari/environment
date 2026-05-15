const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node gmail-thread-last-from-me.js <threadId>');
  process.exit(1);
}

function decodeB64url(data) {
  if (!data) return '';
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
}

function findTextPart(payload) {
  if (!payload) return null;
  if (payload.mimeType === 'text/plain' && payload.body?.data) return payload.body.data;
  if (payload.parts) {
    for (const p of payload.parts) {
      const found = findTextPart(p);
      if (found) return found;
    }
  }
  if (payload.body?.data) return payload.body.data;
  return null;
}

function headersToObj(headers) {
  return Object.fromEntries((headers || []).map(h => [String(h.name || '').toLowerCase(), h.value]));
}

async function main() {
  const threadId = process.argv[2];
  if (!threadId) usage();

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const me = (profile.data.emailAddress || '').toLowerCase();

  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });

  const msgs = thread.data.messages || [];
  const mine = [];

  for (const m of msgs) {
    const h = headersToObj(m.payload?.headers);
    const from = (h.from || '').toLowerCase();
    if (!from.includes(me)) continue;

    const bodyData = findTextPart(m.payload);
    const text = decodeB64url(bodyData) || m.snippet || '';

    mine.push({
      id: m.id,
      threadId,
      internalDate: m.internalDate ? Number(m.internalDate) : null,
      date: h.date || '',
      subject: h.subject || '',
      from: h.from || '',
      to: h.to || '',
      snippet: m.snippet || '',
      text
    });
  }

  mine.sort((a,b) => (a.internalDate||0) - (b.internalDate||0));
  const last = mine[mine.length - 1] || null;

  console.log(JSON.stringify({ me, threadId, found: mine.length, last }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
