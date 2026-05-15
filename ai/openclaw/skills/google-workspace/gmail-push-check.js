const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { PubSub } = require('@google-cloud/pubsub');
const { SubscriberClient } = require('@google-cloud/pubsub').v1;
const { getAuth } = require('./lib');

// Pulls pending Pub/Sub messages for Gmail watch (sync pull), resolves them into new INBOX messages
// via Gmail History, marks them read, and prints a JSON summary.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=secrets/gcp-sa.json node gmail-push-check.js asdrubal-projects gmail-inbox-watch-sub

const STATE_PATH = path.join(__dirname, 'push-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

function headersToObj(headers) {
  return Object.fromEntries((headers || []).map(h => [String(h.name || '').toLowerCase(), h.value]));
}

async function fetchNewFromHistory(gmail, startHistoryId) {
  const ids = new Set();
  let pageToken;
  do {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
      pageToken,
    });
    for (const h of res.data.history || []) {
      for (const added of h.messagesAdded || []) {
        if (added.message?.id) ids.add(added.message.id);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return Array.from(ids);
}

async function main() {
  const [projectId, subId] = process.argv.slice(2);
  if (!projectId || !subId) {
    console.error('Usage: node gmail-push-check.js <gcpProjectId> <subscriptionId>');
    process.exit(1);
  }

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  // Figure baseline historyId
  const state = loadState();
  if (!state.lastHistoryId) {
    try {
      const watchState = JSON.parse(fs.readFileSync(path.join(__dirname, 'watch-state.json'), 'utf8'));
      state.lastHistoryId = watchState.historyId;
    } catch {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      state.lastHistoryId = profile.data.historyId;
    }
  }

  // Sync pull from Pub/Sub
  const subscriber = new SubscriberClient();
  const subscriptionName = subscriber.subscriptionPath(projectId, subId);

  const [pullResponse] = await subscriber.pull({
    subscription: subscriptionName,
    maxMessages: 10,
  });

  const recs = pullResponse.receivedMessages || [];
  if (!recs.length) {
    console.log(JSON.stringify({ pushCount: 0, newCount: 0, new: [] }, null, 2));
    return;
  }

  let maxPushHistoryId = null;
  const ackIds = [];

  for (const rm of recs) {
    ackIds.push(rm.ackId);
    try {
      const data = JSON.parse(Buffer.from(rm.message.data, 'base64').toString('utf8'));
      if (data.historyId) {
        const hid = BigInt(data.historyId);
        if (!maxPushHistoryId || hid > BigInt(maxPushHistoryId)) maxPushHistoryId = data.historyId;
      }
    } catch {}
  }

  // Resolve actual new message IDs via Gmail History since lastHistoryId
  let newIds = [];
  try {
    newIds = await fetchNewFromHistory(gmail, state.lastHistoryId);
  } catch (e) {
    if (e?.response?.status === 404) {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      state.lastHistoryId = profile.data.historyId;
      saveState(state);
      await subscriber.acknowledge({ subscription: subscriptionName, ackIds });
      console.log(JSON.stringify({ pushCount: recs.length, newCount: 0, new: [], reset: true }, null, 2));
      return;
    }
    throw e;
  }

  const items = [];
  for (const id of newIds.slice(0, 10)) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });
    const h = headersToObj(full.data.payload?.headers);
    items.push({
      id,
      threadId: full.data.threadId,
      from: h.from || '',
      subject: h.subject || '(no subject)',
      date: h.date || '',
      snippet: full.data.snippet || '',
    });

    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
  }

  await subscriber.acknowledge({ subscription: subscriptionName, ackIds });

  if (maxPushHistoryId) state.lastHistoryId = String(maxPushHistoryId);
  saveState(state);

  console.log(JSON.stringify({
    pushCount: recs.length,
    newCount: items.length,
    new: items,
    lastHistoryId: state.lastHistoryId,
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
