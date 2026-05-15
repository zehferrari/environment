const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node drive-comment-replies-list.js <fileId> <commentId>');
  process.exit(1);
}

async function main() {
  const [fileId, commentId] = process.argv.slice(2);
  if (!fileId || !commentId) usage();

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.replies.list({
    fileId,
    commentId,
    fields: 'replies(id,createdTime,modifiedTime,author(displayName,emailAddress),content,deleted),nextPageToken'
  });

  const replies = (res.data.replies || []).map(r => ({
    id: r.id,
    createdTime: r.createdTime,
    modifiedTime: r.modifiedTime,
    author: r.author && { displayName: r.author.displayName, emailAddress: r.author.emailAddress },
    content: r.content,
    deleted: r.deleted
  }));

  console.log(JSON.stringify({ fileId, commentId, count: replies.length, replies }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
