const { google } = require('googleapis');
const { getAuth } = require('./lib');
const { b64url, buildMultipartAlternative, fromHeader, parseBodyArgs } = require('./mime');

function usage(extra) {
  if (extra) console.error(extra + '\n');
  console.error('Usage:');
  console.error('  node gmail-reply.js <messageId> <body>');
  console.error('  node gmail-reply.js <messageId> --body-file <path>');
  console.error('  node gmail-reply.js <messageId> -          # body from stdin');
  console.error('');
  console.error('Pass the actual reply text, --body-file=<path>, or "-"');
  console.error('for stdin. NEVER pass a bare path as the body — it would');
  console.error('send the literal path string as the reply text.');
  process.exit(1);
}

function getHeader(headers, name) {
  name = name.toLowerCase();
  const h = (headers || []).find(x => (x.name || '').toLowerCase() === name);
  return h?.value || '';
}

function unescapeNewlines(s) {
  return String(s)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = [];
  const flagRest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--body-file' || a === '-f') {
      flagRest.push(a, argv[++i]);
    } else if (a.startsWith('--body-file=')) {
      flagRest.push(a);
    } else {
      positional.push(a);
    }
  }
  const [messageId, ...rest] = positional;
  if (!messageId) usage('missing <messageId>');

  let replyText;
  try {
    const parsed = parseBodyArgs([...rest, ...flagRest]);
    replyText = parsed.body;
  } catch (e) {
    usage(e.message);
  }
  if (!replyText) usage('missing <body>');
  replyText = unescapeNewlines(replyText);

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

  // Per TEAM_WORKFLOW.md "Email sender header (mandatory)" — registry
  // gives the canonical "Name <email>" form; we previously used the
  // bare Gmail profile address.
  const from = fromHeader();

  const extraHeaders = {};
  if (messageIdHeader) extraHeaders['In-Reply-To'] = messageIdHeader;
  if (refs) extraHeaders['References'] = refs;

  const rawMsg = buildMultipartAlternative({
    from, to: toAddr, subject: replySubject, text: replyText, extraHeaders,
  });

  const sent = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: b64url(rawMsg), threadId },
  });

  console.log(JSON.stringify({
    repliedTo: messageId, threadId, sentId: sent.data.id, from,
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
