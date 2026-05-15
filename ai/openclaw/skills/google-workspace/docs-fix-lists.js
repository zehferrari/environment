const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Converts markdown-ish list lines into real Google Docs lists.
// Works bottom-up to keep indices stable.
// - Lines starting with "- " become bulleted list items.
// - Lines starting with "N) " become numbered list items.
//
// Usage: node docs-fix-lists.js <documentId>

function usage() {
  console.error('Usage: node docs-fix-lists.js <documentId>');
  process.exit(1);
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId) usage();

  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });
  const doc = await docs.documents.get({ documentId });
  const content = doc.data.body?.content || [];

  const targets = [];
  for (const el of content) {
    const p = el.paragraph;
    if (!p) continue;
    const startIndex = el.startIndex;
    const endIndex = el.endIndex;
    const text = (p.elements || []).map(e => e.textRun?.content || '').join('');
    const firstLine = (text || '').replace(/\r\n/g, '\n').split('\n')[0];
    const trimmed = firstLine.trimEnd();

    if (trimmed.startsWith('- ')) {
      targets.push({ kind: 'bullet', startIndex, endIndex, deleteLen: 2 });
      continue;
    }
    const m = /^\s*(\d+)\)\s+/.exec(trimmed);
    if (m) {
      targets.push({ kind: 'number', startIndex, endIndex, deleteLen: m[0].length });
    }
  }

  // Process bottom-up
  targets.sort((a, b) => b.startIndex - a.startIndex);

  const requests = [];
  for (const t of targets) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: t.startIndex, endIndex: t.endIndex },
        bulletPreset: t.kind === 'bullet' ? 'BULLET_DISC_CIRCLE_SQUARE' : 'NUMBERED_DECIMAL_NESTED'
      }
    });
    // Remove the manual prefix
    requests.push({
      deleteContentRange: {
        range: { startIndex: t.startIndex, endIndex: t.startIndex + t.deleteLen }
      }
    });
  }

  if (!requests.length) {
    console.log(JSON.stringify({ documentId, changed: 0 }, null, 2));
    return;
  }

  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
  console.log(JSON.stringify({ documentId, changed: requests.length / 2, items: requests.length }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
