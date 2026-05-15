const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node drive-create-doc.js "Title"');
  process.exit(1);
}

async function main() {
  const title = process.argv.slice(2).join(' ').trim();
  if (!title) usage();

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
    },
    fields: 'id,name,webViewLink',
  });

  console.log(JSON.stringify(res.data, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
