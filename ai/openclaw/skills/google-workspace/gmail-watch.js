const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Usage:
// node gmail-watch.js projects/<project>/topics/<topic> [labelIdOrName...]
// Example:
// node gmail-watch.js projects/asdrubal-projects/topics/gmail-inbox-watch INBOX

async function main() {
  const [topicName, ...labels] = process.argv.slice(2);
  if (!topicName) {
    console.error('Usage: node gmail-watch.js projects/<project>/topics/<topic> [labelId...]');
    process.exit(1);
  }

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const req = {
    userId: 'me',
    requestBody: {
      topicName,
      labelIds: labels.length ? labels : ['INBOX'],
      labelFilterAction: 'include',
    },
  };

  const res = await gmail.users.watch(req);

  const statePath = path.join(__dirname, 'watch-state.json');
  const state = {
    topicName,
    labelIds: req.requestBody.labelIds,
    historyId: res.data.historyId,
    expiration: res.data.expiration,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  console.log(JSON.stringify(state, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
