const { google } = require('googleapis');
const { getAuth } = require('./lib');
const agentSelf = require('../agent-self');

function usage() {
  console.error('Usage: node gmail-send.js to@example.com "Subject" "Body"');
  process.exit(1);
}

const { b64url, buildMultipartAlternative } = require('./mime');

function unescapeNewlines(s) {
  // Allow callers (cron/CLI) to pass literal "\\n" sequences and have them render as real newlines.
  return String(s)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n');
}

async function main() {
  const [to, subject, ...rest] = process.argv.slice(2);
  const body = unescapeNewlines(rest.join(' ').trim());
  if (!to || !subject || !body) usage();

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  // Per TEAM_WORKFLOW.md "Email sender header (mandatory)": always
  // send as "Name <email>" pulled from the registry. The Gmail profile's
  // bare emailAddress is intentionally NOT used — recipients need to see
  // who's writing, not just the mailbox.
  const from = agentSelf.fromHeader();

  const msg = buildMultipartAlternative({ from, to, subject, text: body });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: b64url(msg),
    },
  });

  console.log(JSON.stringify({
    from,
    to,
    subject,
    id: res.data.id,
    threadId: res.data.threadId,
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
