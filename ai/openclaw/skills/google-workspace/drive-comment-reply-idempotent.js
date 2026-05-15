const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuth } = require('./lib');

const STATE_PATH = path.join(__dirname, 'drive-comment-state.json');

function usage() {
  console.error('Usage: node drive-comment-reply-idempotent.js <fileId> <commentId> "reply text"');
  process.exit(1);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { sent: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

function keyFor(fileId, commentId, content) {
  const norm = String(content).trim().replace(/\s+/g, ' ');
  return `${fileId}:${commentId}:${norm}`;
}

async function main() {
  const [fileId, commentId, ...rest] = process.argv.slice(2);
  const content = rest.join(' ').trim();
  if (!fileId || !commentId || !content) usage();

  const state = loadState();
  state.sent = state.sent || {};
  const k = keyFor(fileId, commentId, content);
  if (state.sent[k]) {
    console.log(JSON.stringify({ skipped: true, reason: 'duplicate', existing: state.sent[k] }, null, 2));
    return;
  }

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.replies.create({
    fileId,
    commentId,
    requestBody: { content },
    fields: 'id,createdTime,author(displayName,emailAddress),content'
  });

  state.sent[k] = { id: res.data.id, createdTime: res.data.createdTime };
  // prune best-effort
  const keys = Object.keys(state.sent);
  if (keys.length > 1000) {
    keys.sort((a,b) => (state.sent[a].createdTime||'').localeCompare(state.sent[b].createdTime||''));
    for (let i=0;i<keys.length-1000;i++) delete state.sent[keys[i]];
  }
  saveState(state);

  console.log(JSON.stringify(res.data, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
