const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node drive-reply-delete.js <fileId> <commentId> <replyId>');
  process.exit(1);
}

async function main() {
  const [fileId, commentId, replyId] = process.argv.slice(2);
  if (!fileId || !commentId || !replyId) usage();

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  await drive.replies.delete({ fileId, commentId, replyId });
  console.log(JSON.stringify({ ok: true, fileId, commentId, replyId }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
