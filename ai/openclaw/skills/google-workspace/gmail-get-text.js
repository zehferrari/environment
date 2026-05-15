const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node gmail-get-text.js <messageId>');
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
  // fallback: any body data
  if (payload.body?.data) return payload.body.data;
  return null;
}

async function main() {
  const id = process.argv[2];
  if (!id) usage();

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const headers = Object.fromEntries((msg.data.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));

  const bodyData = findTextPart(msg.data.payload);
  const text = decodeB64url(bodyData) || msg.data.snippet || '';

  console.log(JSON.stringify({
    id,
    threadId: msg.data.threadId,
    from: headers['from'] || '',
    to: headers['to'] || '',
    subject: headers['subject'] || '(no subject)',
    date: headers['date'] || '',
    snippet: msg.data.snippet || '',
    text
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
