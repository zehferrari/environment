const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node drive-comment-delete.js <fileId> <commentId>');
  process.exit(1);
}

async function main() {
  const [fileId, commentId] = process.argv.slice(2);
  if (!fileId || !commentId) usage();

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  await drive.comments.delete({ fileId, commentId });
  console.log(JSON.stringify({ ok: true, fileId, commentId }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
