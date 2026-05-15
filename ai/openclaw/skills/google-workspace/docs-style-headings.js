const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Scans paragraphs and applies HEADING_1 to known headings.
// Usage: node docs-style-headings.js <documentId>

const HEADINGS = new Set([
  'Overview',
  'Goals',
  'Core features (MVP)',
  'Advanced (optional, not required for MVP)',
  'Open questions',
  'Next steps'
]);

function usage() {
  console.error('Usage: node docs-style-headings.js <documentId>');
  process.exit(1);
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId) usage();

  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  const doc = await docs.documents.get({ documentId });
  const content = doc.data.body?.content || [];

  const requests = [];

  for (const el of content) {
    const p = el.paragraph;
    if (!p) continue;
    const startIndex = el.startIndex;
    const endIndex = el.endIndex;
    const text = (p.elements || []).map(e => e.textRun?.content || '').join('');
    const line = (text || '').replace(/\r\n/g, '\n').split('\n')[0].trim();

    if (HEADINGS.has(line)) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex, endIndex },
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          fields: 'namedStyleType'
        }
      });
    }
  }

  if (!requests.length) {
    console.log(JSON.stringify({ documentId, changed: 0 }, null, 2));
    return;
  }

  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
  console.log(JSON.stringify({ documentId, changed: requests.length }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
