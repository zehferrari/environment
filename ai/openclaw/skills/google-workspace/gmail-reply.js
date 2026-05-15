const { google } = require('googleapis');
const { getAuth } = require('./lib');
const { b64url, buildMultipartAlternative } = require('./mime');

function usage() {
  console.error('Usage: node gmail-reply.js <messageId> "Reply body"');
  process.exit(1);
}

function getHeader(headers, name) {
  name = name.toLowerCase();
  const h = (headers || []).find(x => (x.name || '').toLowerCase() === name);
  return h?.value || '';
}

function unescapeNewlines(s) {
  // Allow callers (cron/CLI) to pass literal "\\n" sequences and have them render as real newlines.
  return String(s)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n');
}

async function main() {
  const [messageId, ...rest] = process.argv.slice(2);
  const replyText = unescapeNewlines(rest.join(' ').trim());
  if (!messageId || !replyText) usage();

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const original = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-Id', 'References', 'Reply-To'],
  });

  const threadId = original.data.threadId;
  const headers = original.data.payload?.headers || [];

  const toAddr = getHeader(headers, 'reply-to') || getHeader(headers, 'from');
  const subject = getHeader(headers, 'subject') || '';
  const messageIdHeader = getHeader(headers, 'message-id');
  const references = getHeader(headers, 'references');

  const replySubject = subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;
  const refs = [references, messageIdHeader].filter(Boolean).join(' ').trim();

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const me = profile.data.emailAddress;

  const extraHeaders = {};
  if (messageIdHeader) extraHeaders['In-Reply-To'] = messageIdHeader;
  if (refs) extraHeaders['References'] = refs;

  const rawMsg = buildMultipartAlternative({
    from: me,
    to: toAddr,
    subject: replySubject,
    text: replyText,
    extraHeaders,
  });

  const sent = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: b64url(rawMsg),
      threadId,
    },
  });

  console.log(JSON.stringify({
    repliedTo: messageId,
    threadId,
    sentId: sent.data.id,
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
