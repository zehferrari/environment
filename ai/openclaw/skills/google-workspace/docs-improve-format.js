const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Improves formatting in-place:
// - Convert lines starting with "- " into real bullet lists
// - Convert lines starting with "1) ", "2) ", ... into real numbered lists
// - Remove the literal "- " and "N) " prefixes
// - Add a simple architecture diagram as a table under a new heading
// - Remove the "Open questions" section body content and replace with a single line
//   (questions will be tracked via comments)
//
// Usage: node docs-improve-format.js <documentId>

function usage() {
  console.error('Usage: node docs-improve-format.js <documentId>');
  process.exit(1);
}

function collectParagraphs(doc) {
  const content = doc.data.body?.content || [];
  const paragraphs = [];
  for (const el of content) {
    const p = el.paragraph;
    if (!p) continue;
    const text = (p.elements || []).map(e => e.textRun?.content || '').join('');
    paragraphs.push({ startIndex: el.startIndex, endIndex: el.endIndex, text });
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

  const requests = [];

  // Find Open questions section range (heading line -> before Next steps heading)
  let openQStart = null;
  let openQEnd = null;
  for (const p of paragraphs) {
    const line = (p.text || '').replace(/\r\n/g, '\n').split('\n')[0].trim();
    if (line === 'Open questions') openQStart = p.startIndex;
    if (openQStart && line === 'Next steps') {
      openQEnd = p.startIndex;
      break;
    }
  }

  if (openQStart && openQEnd && openQEnd > openQStart) {
    // Delete everything after the heading line up to Next steps heading
    // Keep the heading paragraph itself.
    // Find end of the Open questions heading paragraph
    const headingPara = paragraphs.find(p => p.startIndex === openQStart);
    const keepFrom = headingPara?.endIndex || (openQStart + 1);
    if (openQEnd > keepFrom + 1) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: keepFrom, endIndex: openQEnd }
        }
      });
      // Insert placeholder line under Open questions heading
      requests.push({
        insertText: {
          location: { index: keepFrom },
          text: 'Questions are tracked as comment bubbles in this doc to preserve decision history.\n'
        }
      });
    }
  }

  // Convert bullet and numbered lists
  for (const p of paragraphs) {
    const line = (p.text || '').replace(/\r\n/g, '\n').split('\n')[0];
    const trimmed = line.trimEnd();

    if (trimmed.startsWith('- ')) {
      // remove '- '
      requests.push({
        deleteContentRange: { range: { startIndex: p.startIndex, endIndex: p.startIndex + 2 } }
      });
      // apply bullets to paragraph
      requests.push({
        createParagraphBullets: {
          range: { startIndex: p.startIndex, endIndex: p.endIndex },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE'
        }
      });
    }

    const m = /^\s*(\d+)\)\s+/.exec(trimmed);
    if (m) {
      const prefixLen = m[0].length;
      requests.push({
        deleteContentRange: { range: { startIndex: p.startIndex, endIndex: p.startIndex + prefixLen } }
      });
      requests.push({
        createParagraphBullets: {
          range: { startIndex: p.startIndex, endIndex: p.endIndex },
          bulletPreset: 'NUMBERED_DECIMAL_NESTED'
        }
      });
    }
  }

  // Add architecture diagram at end (heading + table)
  const latest = await docs.documents.get({ documentId });
  const endIndex = latest.data.body?.content?.[latest.data.body.content.length - 1]?.endIndex || 1;
  const insertAt = Math.max(1, endIndex - 1);

  requests.push({
    insertText: {
      location: { index: insertAt },
      text: '\nArchitecture diagram\n'
    }
  });
  // Apply heading style to the just-inserted paragraph (best effort)
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: insertAt, endIndex: insertAt + 'Architecture diagram'.length + 1 },
      paragraphStyle: { namedStyleType: 'HEADING_1' },
      fields: 'namedStyleType'
    }
  });

  const tableLoc = insertAt + ('\nArchitecture diagram\n'.length);
  requests.push({
    insertTable: {
      rows: 5,
      columns: 2,
      location: { index: tableLoc }
    }
  });

  // We won't attempt to fill table cells here (cell index math is fiddly);
  // we'll fill them in a follow-up pass once the table exists.

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
