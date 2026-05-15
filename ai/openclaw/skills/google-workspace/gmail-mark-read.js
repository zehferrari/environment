const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node gmail-mark-read.js <messageId>');
  process.exit(1);
}

async function main() {
  const id = process.argv[2];
  if (!id) usage();

  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.modify({
    userId: 'me',
    id,
    requestBody: {
      removeLabelIds: ['UNREAD'],
    },
  });

  console.log(JSON.stringify({ id: res.data.id, labelIds: res.data.labelIds }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
