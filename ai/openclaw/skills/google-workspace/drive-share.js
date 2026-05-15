const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node drive-share.js <fileId> <email> [role]');
  console.error('role: reader|commenter|writer (default: writer)');
  process.exit(1);
}

async function main() {
  const [fileId, email, role = 'writer'] = process.argv.slice(2);
  if (!fileId || !email) usage();

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  await drive.permissions.create({
    fileId,
    requestBody: {
      type: 'user',
      role,
      emailAddress: email,
    },
    sendNotificationEmail: false,
  });

  const meta = await drive.files.get({ fileId, fields: 'id,name,webViewLink' });
  console.log(JSON.stringify(meta.data, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
