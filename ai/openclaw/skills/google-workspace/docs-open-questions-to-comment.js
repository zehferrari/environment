const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Replaces the Open questions section body with a single line (keeps heading).
// Usage: node docs-open-questions-to-comment.js <documentId>

function usage() {
  console.error('Usage: node docs-open-questions-to-comment.js <documentId>');
  process.exit(1);
}

function collectParagraphs(doc) {
  const content = doc.data.body?.content || [];
  const paragraphs = [];
  for (const el of content) {
    const p = el.paragraph;
    if (!p) continue;
    const text = (p.elements || []).map(e => e.textRun?.content || '').join('');
    const line = (text || '').replace(/\r\n/g, '\n').split('\n')[0].trim();
    paragraphs.push({ startIndex: el.startIndex, endIndex: el.endIndex, line });
  }
  return paragraphs;
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId) usage();

  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  const doc = await docs.documents.get({ documentId });
  const paragraphs = collectParagraphs(doc);

  let openHeading = null;
  let nextHeading = null;

  for (const p of paragraphs) {
    if (p.line === 'Open questions') openHeading = p;
    else if (openHeading && p.line === 'Next steps') { nextHeading = p; break; }
  }

  if (!openHeading || !nextHeading) {
    console.log(JSON.stringify({ documentId, changed: false, reason: 'section not found' }, null, 2));
    return;
  }

  const keepFrom = openHeading.endIndex;
  const deleteTo = nextHeading.startIndex;

  const requests = [];
  if (deleteTo > keepFrom + 1) {
    requests.push({ deleteContentRange: { range: { startIndex: keepFrom, endIndex: deleteTo } } });
    requests.push({ insertText: { location: { index: keepFrom }, text: 'Questions are tracked in comment bubbles in this doc.\n' } });
  }

  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
  console.log(JSON.stringify({ documentId, changed: true }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
