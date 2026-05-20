const { google } = require('googleapis');
const { getAuth } = require('./lib');
const { b64url, buildMultipartAlternative, fromHeader, parseBodyArgs } = require('./mime');

function usage(extra) {
  if (extra) console.error(extra + '\n');
  console.error('Usage:');
  console.error('  node gmail-send.js <to> <subject> <body>');
  console.error('  node gmail-send.js <to> <subject> --body-file <path>');
  console.error('  node gmail-send.js <to> <subject> -          # body from stdin');
  console.error('');
  console.error('Pass the actual body text on the command line, or use');
  console.error('--body-file to load it from a path, or pass "-" as the body');
  console.error('argument to read from stdin. NEVER pass a path as the body');
  console.error('text expecting the file to be loaded automatically — that');
  console.error('would send the literal path string as the email body.');
  process.exit(1);
}

function unescapeNewlines(s) {
  return String(s)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  // Separate flags from positionals — parseBodyArgs handles --body-file
  // but we also need to peel off <to> and <subject> first.
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
  const [to, subject, ...rest] = positional;
  if (!to || !subject) usage('missing <to> or <subject>');

  let body;
  try {
    const parsed = parseBodyArgs([...rest, ...flagRest]);
    body = parsed.body;
  } catch (e) {
    usage(e.message);
  }
  if (!body) usage('missing <body>');
  body = unescapeNewlines(body);

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  // Per TEAM_WORKFLOW.md "Email sender header (mandatory)": always
  // "Name <email>" from the registry — never bare address.
  const from = fromHeader();

  const msg = buildMultipartAlternative({ from, to, subject, text: body });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: b64url(msg) },
  });

  console.log(JSON.stringify({
    from, to, subject, id: res.data.id, threadId: res.data.threadId,
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
