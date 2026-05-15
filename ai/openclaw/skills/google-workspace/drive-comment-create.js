const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node drive-comment-create.js <fileId> "comment text"');
  process.exit(1);
}

async function main() {
  const [fileId, ...rest] = process.argv.slice(2);
  const content = rest.join(' ').trim();
  if (!fileId || !content) usage();

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.comments.create({
    fileId,
    requestBody: { content },
    fields: 'id,createdTime,author(displayName,emailAddress),content'
  });

  console.log(JSON.stringify(res.data, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
