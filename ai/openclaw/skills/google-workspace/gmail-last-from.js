const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node gmail-last-from.js "sender name or email"');
  process.exit(1);
}

async function main() {
  const q = process.argv.slice(2).join(' ').trim();
  if (!q) usage();

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `from:${q}`,
    maxResults: 1,
  });

  const msgId = list.data.messages?.[0]?.id;
  if (!msgId) {
    console.log(`No messages found from: ${q}`);
    return;
  }

  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: msgId,
    format: 'full',
  });

  const headers = Object.fromEntries((msg.data.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  const subject = headers['subject'] || '(no subject)';
  const from = headers['from'] || '';
  const date = headers['date'] || '';

  // Try to find a readable snippet.
  const snippet = msg.data.snippet || '';

  console.log(JSON.stringify({
    id: msgId,
    from,
    subject,
    date,
    snippet,
    threadId: msg.data.threadId,
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
