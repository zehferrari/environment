const { google } = require('googleapis');
const { getAuth } = require('./lib');
const { sendTelegram, sendEmail, RACHAEL_EMAIL } = require('./notifier');

function headersToObj(headers) {
  return Object.fromEntries((headers || []).map(h => [String(h.name || '').toLowerCase(), h.value]));
}

async function main() {
  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread',
    maxResults: 20
  });

  const messages = res.data.messages || [];
  console.log(`Found ${messages.length} unread messages.`);

  for (const m of messages) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const headers = headersToObj(msg.data.payload.headers);
      const from = headers.from || '';
      const subject = headers.subject || '(no subject)';
      const snippet = msg.data.snippet || '';

      // --- FILTERS ---
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

      // Mark as read
      await gmail.users.messages.modify({
         userId: 'me', id: m.id,
         requestBody: { removeLabelIds: ['UNREAD'] }
      });
      console.log(`Marked ${m.id} as read.`);

    } catch (err) {
      console.error(`Error processing msg ${m.id}:`, err);
    }
  }
}

main().catch(console.error);
