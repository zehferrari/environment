const fs = require('fs');
const { google } = require('googleapis');
const { getAuth } = require('./lib');
const agentSelf = require('../agent-self');
const { b64url, buildMultipartAlternative } = require('./mime');

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
  // Allow callers (cron/CLI) to pass literal "\\n" sequences and have them render as real newlines.
  return String(s)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n');
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function looksLikePathArg(s) {
  // Heuristic: a single argument that starts with "/" (absolute path)
  // AND contains no whitespace AND that file exists on disk. Common
  // mistake: agent passes /tmp/reply.txt as the body, intending the
  // file's contents. Refuse to send the literal path as the message
  // body — surface the mistake instead of silently emitting bad mail.
  return typeof s === 'string'
    && /^\/[^\s]+$/.test(s)
    && fs.existsSync(s)
    && fs.statSync(s).isFile();
}

function parseArgs(argv) {
  const out = { positional: [], bodyFile: null, stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--body-file' || a === '-f') {
      out.bodyFile = argv[++i];
      if (!out.bodyFile) usage('--body-file requires a path');
    } else if (a.startsWith('--body-file=')) {
      out.bodyFile = a.slice('--body-file='.length);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [to, subject, ...rest] = args.positional;

  if (!to || !subject) usage('missing <to> or <subject>');

  let body;
  if (args.bodyFile) {
    if (!fs.existsSync(args.bodyFile)) usage(`--body-file path does not exist: ${args.bodyFile}`);
    body = fs.readFileSync(args.bodyFile, 'utf8').trim();
  } else if (rest.length === 1 && rest[0] === '-') {
    body = readStdin().trim();
  } else {
    const raw = rest.join(' ').trim();
    if (!raw) usage('missing <body>');
    // Guard: if the agent passed what looks like an absolute path to an
    // existing file as the body, they almost certainly meant --body-file.
    // Sending the literal path string is the bug that produced the
    // "I got an email containing only /tmp/reply_*.txt" incident.
    if (rest.length === 1 && looksLikePathArg(raw)) {
      usage(
        `Body argument "${raw}" looks like a path to an existing file, ` +
        `but gmail-send.js does not auto-load file bodies. ` +
        `Use --body-file=${raw} to send the file contents, ` +
        `or pass the actual body text as a literal string.`
      );
    }
    body = unescapeNewlines(raw);
  }

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  // Per TEAM_WORKFLOW.md "Email sender header (mandatory)": always
  // send as "Name <email>" pulled from the registry.
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
