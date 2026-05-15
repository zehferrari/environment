const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuth } = require('./lib');

function usage() {
  console.error('Usage: node docs-overwrite.js <docId> <textFilePath>');
  process.exit(1);
}

function loadText(p) {
  return fs.readFileSync(p, 'utf8');
}

async function main() {
  const [docId, filePath] = process.argv.slice(2);
  if (!docId || !filePath) usage();

  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const text = loadText(abs);

  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  // Get current doc to compute end index.
  const doc = await docs.documents.get({ documentId: docId });
  const body = doc.data.body;
  const endIndex = body?.content?.[body.content.length - 1]?.endIndex;

  const requests = [];

  // Delete existing content (keep the initial newline at index 1).
  if (typeof endIndex === 'number' && endIndex > 2) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIndex - 1 }
      }
    });
  }

  // Insert new content.
  requests.push({
    insertText: {
      location: { index: 1 },
      text
    }
  });

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests }
  });

  const updated = await docs.documents.get({ documentId: docId });
  console.log(JSON.stringify({
    documentId: docId,
    title: updated.data.title,
    revisionId: updated.data.revisionId
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
