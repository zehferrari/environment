const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuth } = require('./lib');

const STATE_PATH = path.join(__dirname, 'state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { seen: {} }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function main() {
  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const state = loadState();
  state.seen = state.seen || {};

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox is:unread',
    maxResults: 10,
  });

  const msgs = res.data.messages || [];
  const newOnes = [];

  for (const m of msgs) {
    if (state.seen[m.id]) continue;
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From','To','Subject','Date'] });
    const headers = Object.fromEntries((full.data.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    newOnes.push({
      id: m.id,
      threadId: full.data.threadId,
      from: headers['from'] || '',
      subject: headers['subject'] || '(no subject)',
      date: headers['date'] || '',
      snippet: full.data.snippet || '',
    });
    state.seen[m.id] = Date.now();
  }

  // prune state to keep it small
  const ids = Object.keys(state.seen);
  if (ids.length > 500) {
    ids.sort((a,b) => state.seen[a]-state.seen[b]);
    for (let i=0;i<ids.length-500;i++) delete state.seen[ids[i]];
  }
  saveState(state);

  console.log(JSON.stringify({ newCount: newOnes.length, new: newOnes }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
