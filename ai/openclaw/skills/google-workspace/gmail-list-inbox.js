const { google } = require('googleapis');
const { getAuth } = require('./lib');

async function main() {
  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox',
    maxResults: 20,
  });

  const msgs = res.data.messages || [];
  const emails = [];

  for (const m of msgs) {
    const full = await gmail.users.messages.get({ 
      userId: 'me', 
      id: m.id, 
      format: 'metadata', 
      metadataHeaders: ['From','To','Subject','Date'] 
    });
    
    const headers = Object.fromEntries(
      (full.data.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
    );
    
    emails.push({
      id: m.id,
      from: headers['from'] || '',
      subject: headers['subject'] || '(no subject)',
      date: headers['date'] || '',
      snippet: full.data.snippet || '',
      unread: full.data.labelIds?.includes('UNREAD') || false,
    });
  }

  console.log(JSON.stringify({ count: emails.length, emails }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
