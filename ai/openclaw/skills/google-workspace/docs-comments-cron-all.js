/*
Docs comments monitor + workflow (ALL Google Docs)
UPDATED: Immediate action for Zeh/Rachael; Pending notification for others.
*/

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { google } = require('googleapis');
const { getAuth } = require('./lib');
const { sendTelegram, sendEmail, RACHAEL_EMAIL } = require('./notifier');
const self = require('../agent-self');

// Self identities for dedupe (resolved from /etc/openclaw/agents.json by current user)
const SELF_DISPLAY_NAMES = new Set([self.name, self.firstName]);

function readJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function writeJsonAtomic(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}
function isoNow() { return new Date().toISOString(); }

function ms(t) {
  const v = Date.parse(t);
  return Number.isFinite(v) ? v : NaN;
}

async function listAllDocs(drive) {
  const q = "mimeType='application/vnd.google-apps.document' and trashed=false";
  let pageToken = undefined;
  const files = [];
  do {
    const res = await drive.files.list({
      q,
      pageSize: 100,
      pageToken,
      fields: 'nextPageToken,files(id,name,modifiedTime,owners(displayName,emailAddress),webViewLink)'
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return files;
}

async function listComments(drive, fileId) {
  let pageToken = undefined;
  const comments = [];
  try {
    do {
      const res = await drive.comments.list({
        fileId,
        pageSize: 100,
        pageToken,
        fields: 'nextPageToken,comments(id,createdTime,modifiedTime,author(displayName,emailAddress),content,deleted,quotedFileContent,resolved)'
      });
      comments.push(...(res.data.comments || []));
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  } catch (e) {
    // Ignore 404 or permission errors on specific files
  }
  return comments;
}

async function listReplies(drive, fileId, commentId) {
  let pageToken = undefined;
  const replies = [];
  try {
    do {
      const res = await drive.replies.list({
        fileId,
        commentId,
        pageSize: 100,
        pageToken,
        fields: 'nextPageToken,replies(id,createdTime,modifiedTime,author(displayName,emailAddress),content,deleted)'
      });
      replies.push(...(res.data.replies || []));
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  } catch (e) {}
  return replies;
}

function runTool(script, args) {
  const scriptPath = path.join(__dirname, script);
  execFileSync('node', [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function exportAndQc(fileId, outPdf) {
  runTool('drive-export-pdf.js', [fileId, outPdf]);
  const qcRaw = execFileSync('node', [path.join(__dirname, 'pdf-qc.js'), outPdf], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  return JSON.parse(qcRaw);
}

function safeBasename(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'doc';
}

async function main() {
  const statePathArg = process.argv[2] || 'docs-comment-state.json';
  const statePath = path.resolve(__dirname, statePathArg);

  const state = readJson(statePath, { lastScanTime: null, handledCommentIds: {} });
  state.handledCommentIds = state.handledCommentIds || {};

  const lastScanMs = ms(state.lastScanTime);
  const lastScanCutoff = Number.isFinite(lastScanMs) ? lastScanMs : 0;

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const docs = await listAllDocs(drive);

  const candidates = [];
  const nowIso = isoNow();

  for (const f of docs) {
    const comments = await listComments(drive, f.id);
    for (const c of comments) {
      if (cat > /tmp/auth-manual.js << 'EOF'
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

const SECRETS_DIR = path.join(__dirname, 'secrets');
const CLIENT_PATH = path.join(SECRETS_DIR, 'oauth-client.json');
const TOKEN_PATH = path.join(SECRETS_DIR, 'token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/photoslibrary',
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/pubsub'
];

function loadClient() {
  const raw = fs.readFileSync(CLIENT_PATH, 'utf8');
  const json = JSON.parse(raw);
  const c = json.installed || json.web;
  if (!c) throw new Error('oauth-client.json must have installed or web section');
  const redirectUris = c.redirect_uris || [];
  const redirectUri = redirectUris[0];
  if (!redirectUri) throw new Error('No redirect_uris in oauth-client.json');
  return { client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirectUri };
}

async function main() {
  if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true });
  if (!fs.existsSync(CLIENT_PATH)) {
    console.error();
    process.exit(1);
  }

  const { client_id, client_secret, redirect_uri } = loadClient();
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n1) Open this URL in your browser and complete consent:\n');
  console.log(authUrl);
  console.log('\n2) After consent you will be redirected to the redirect URI (it may fail to load).');
  console.log('   Copy the full URL from your browser address bar. It will contain ?code=...');
  console.log('   Paste either the CODE value, or the whole redirected URL below.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = await new Promise(resolve => rl.question('Code or redirect URL: ', ans => resolve(ans.trim())));
  rl.close();

  let code = input;
  if (input.startsWith('http://') || input.startsWith('https://')) {
    const u = new URL(input);
    code = u.searchParams.get('code') || '';
  }

  if (!code) {
    throw new Error('No code found in input. Paste the code=... value (or full URL).');
  }

  const { tokens } = await oAuth2Client.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log();
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
