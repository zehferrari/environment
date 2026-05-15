const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.log(JSON.stringify({ error: 'Usage: node drive-comments-list.js <fileId> [pageSize]' }));
  process.exit(0);
}

async function main() {
  const fileId = process.argv[2];
  const pageSize = Number(process.argv[3] || 20);
  if (!fileId) return usage();

  try {
    const auth = getAuth();
    const drive = google.drive({ version: 'v3', auth });

    const res = await drive.comments.list({
      fileId,
      pageSize,
      fields: 'comments(id,createdTime,modifiedTime,author(displayName,emailAddress),content,deleted,quotedFileContent,resolved),nextPageToken'
    });

    const comments = (res.data.comments || []).map(c => ({
      commentId: c.id,
      createdTime: c.createdTime,
      modifiedTime: c.modifiedTime,
      author: c.author && { displayName: c.author.displayName, emailAddress: c.author.emailAddress },
      content: c.content,
      resolved: c.resolved,
      deleted: c.deleted,
      quoted: c.quotedFileContent && {
        value: c.quotedFileContent.value,
        mimeType: c.quotedFileContent.mimeType
      }
    }));

    console.log(JSON.stringify({ fileId, count: comments.length, comments }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ error: err.message, details: err?.response?.data || err }));
    process.exit(0);
  }
}

main();
