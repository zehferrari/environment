const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { PubSub } = require('@google-cloud/pubsub');
const { getAuth } = require('./lib');
const { sendTelegram, sendEmail, RACHAEL_EMAIL } = require('./notifier');

// Watches a Pub/Sub subscription for Gmail push notifications.
// UPDATED: Age check REMOVED due to server clock skew.

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
  try {
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
  } catch (e) {
    if (e?.response?.status === 404) return null; // History expired
    throw e;
  }
  return Array.from(ids);
}

async function main() {
  const subName = process.argv[2];
  if (!subName) {
    console.error('Usage: node gmail-push-worker.js <subscriptionName>');
    process.exit(1);
  }

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });
  
  const pubsub = new PubSub({ 
    projectId: 'asdrubal-projects',
    authClient: auth 
  });
  const subscription = pubsub.subscription(subName);

  const state = loadState();

  if (!state.lastHistoryId) {
    try {
      const watchState = JSON.parse(fs.readFileSync(path.join(__dirname, 'watch-state.json'), 'utf8'));
      state.lastHistoryId = watchState.historyId;
    } catch {}
  }
  if (!state.lastHistoryId) {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    state.lastHistoryId = profile.data.historyId;
  }
  saveState(state);

  console.error(`Gmail push worker listening on: ${subName}`);

  subscription.on('message', async (message) => {
    try {
      const data = JSON.parse(message.data ? message.data.toString('utf8') : '{}');
      if (!data.historyId) {
        message.ack();
        return;
      }

      let newIds = await fetchNewFromHistory(gmail, state.lastHistoryId);
      
      if (newIds === null) {
        console.error('History expired, resetting baseline...');
        const profile = await gmail.users.getProfile({ userId: 'me' });
        state.lastHistoryId = profile.data.historyId;
        saveState(state);
        message.ack();
        return;
      }

      state.lastHistoryId = data.historyId;
      saveState(state);

      for (const id of newIds) {
        try {
          const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
          const headers = headersToObj(msg.data.payload.headers);
          
          // --- FILTERS ---
          // AGE CHECK REMOVED

          // 2. Automated/Spam Filter
          const from = headers.from || '';
          const subject = headers.subject || '(no subject)';
          const snippet = msg.data.snippet || '';
          
          const isAutomated = 
            (headers['list-unsubscribe'] && !from.includes('zeh.me')) ||
            headers['precedence'] === 'bulk' || 
            headers['x-autoreply'] ||
            from.toLowerCase().includes('no-reply') || 
            from.toLowerCase().includes('noreply') ||
            from.toLowerCase().includes('notifications@') ||
            from.toLowerCase().includes('bounce');

          const isZeh = from.includes('e@zeh.me') || from.includes('Zeh Ferrari');
          const isRachael = from.includes('contact@rachaelsmith.net.au') || from.includes('Rachael Smith');

          if (isAutomated && !isZeh && !isRachael) {
             console.log(`Skipping automated/bulk email from: ${from}`);
             continue;
          }

          const notifMsg = `From: ${from}\nSubject: ${subject}\nSnippet: ${snippet}`;

          if (isZeh) {
            console.log(`[Email] Immediate Action for Zeh: ${subject}`);
            sendTelegram(`🚀 *Immediate Action Required* (Email)\n${notifMsg}\n\n_I'm on it!_`);
          } else if (isRachael) {
            console.log(`[Email] Immediate Action for Rachael: ${subject}`);
            sendEmail(RACHAEL_EMAIL, `Re: ${subject}`, `I received your email and I'm working on it immediately.\n\nContext: ${snippet}`);
          } else {
            console.log(`[Email] Pending Request from ${from}`);
            sendTelegram(`📝 *Pending Request* (Email)\n${notifMsg}\n\n_Waiting for confirmation._`);
          }

          await gmail.users.messages.modify({
             userId: 'me', id,
             requestBody: { removeLabelIds: ['UNREAD'] }
          });

        } catch (err) {
          console.error(`Error processing msg ${id}:`, err);
        }
      }

      message.ack();
    } catch (e) {
      console.error('Error handling push message:', e);
      message.nack();
    }
  });
}

main().catch(console.error);
