const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node drive-comment-reply.js <fileId> <commentId> "reply text"');
  process.exit(1);
}

async function main() {
  const [fileId, commentId, ...rest] = process.argv.slice(2);
  const content = rest.join(' ').trim();
  if (!fileId || !commentId || !content) usage();

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.replies.create({
    fileId,
    commentId,
    requestBody: { content },
    fields: 'id,createdTime,author(displayName,emailAddress),content'
  });

  console.log(JSON.stringify(res.data, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
