const { google } = require('googleapis');
const { getAuth } = require('./lib');

async function main() {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    pageSize: 20,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
  });

  console.log(JSON.stringify(res.data.files || [], null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
