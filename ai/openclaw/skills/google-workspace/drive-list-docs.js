const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Lists Google Docs the account can see (first N)
// Usage: node drive-list-docs.js [pageSize]

async function main() {
  const pageSize = Number(process.argv[2] || 50);
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const q = "mimeType='application/vnd.google-apps.document' and trashed=false";

  const res = await drive.files.list({
    q,
    pageSize,
    fields: 'files(id,name,modifiedTime,owners(displayName,emailAddress),webViewLink),nextPageToken'
  });

  console.log(JSON.stringify({
    count: (res.data.files || []).length,
    files: res.data.files || [],
    nextPageToken: res.data.nextPageToken || null
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
