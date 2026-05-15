const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Make a Google Doc presentable by converting markdown-ish headings into real Docs styles.
// - Converts lines starting with "# " to TITLE
// - "## " to HEADING_1
// - "### " to HEADING_2
// - Removes the leading # markers
// - Bolds lines that start with "MVP:" or "DECISION:" or "NOTE:"
//
// Usage: node docs-presentable.js <documentId>

function usage() {
  console.error('Usage: node docs-presentable.js <documentId>');
  process.exit(1);
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId) usage();

  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  const doc = await docs.documents.get({ documentId });
  const content = doc.data.body?.content || [];

  // Build a plain-text view with indices for paragraph elements.
  const paragraphs = [];
  for (const el of content) {
    const p = el.paragraph;
    if (!p) continue;
    const startIndex = el.startIndex;
    const endIndex = el.endIndex;
    const text = (p.elements || [])
      .map(e => e.textRun?.content || '')
      .join('');
    paragraphs.push({ startIndex, endIndex, text });
  }

  const requests = [];

  for (const p of paragraphs) {
    const line = (p.text || '').replace(/\r\n/g, '\n').split('\n')[0] || '';

    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line.trimEnd());
    if (headingMatch) {
      const hashes = headingMatch[1];
      const styleType = hashes.length === 1 ? 'TITLE' : hashes.length === 2 ? 'HEADING_1' : 'HEADING_2';

      // Remove the leading hashes + space on the first line of the paragraph.
      // We only delete within this paragraph range.
      const prefixLen = hashes.length + 1; // + space
      requests.push({
        deleteContentRange: {
          range: { startIndex: p.startIndex, endIndex: p.startIndex + prefixLen }
        }
      });

      // Apply paragraph style to the paragraph.
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: p.startIndex, endIndex: p.endIndex },
          paragraphStyle: { namedStyleType: styleType },
          fields: 'namedStyleType'
        }
      });
      continue;
    }

    const emph = /^(MVP:|DECISION:|NOTE:)\s+/i.test(line.trim());
    if (emph) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: p.startIndex, endIndex: Math.min(p.endIndex, p.startIndex + line.length) },
          textStyle: { bold: true },
          fields: 'bold'
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
