const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Polishes the New WebApp plan doc in-place:
// - Fixes common typos via replaceAllText
// - Converts markdown-ish headings into real Docs styles (TITLE / HEADING_1 / HEADING_2)
// - Removes leading # markers
//
// NOTE: This avoids full overwrites to preserve comment context.
//
// Usage: node docs-polish-newwebapp.js <documentId>

function usage() {
  console.error('Usage: node docs-polish-newwebapp.js <documentId>');
  process.exit(1);
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId) usage();

  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  const doc = await docs.documents.get({ documentId });
  const content = doc.data.body?.content || [];

  const typoFixes = [
    ['##meline', 'Timeline'],
    ['## Keighlights', '## Key highlights'],
    ['Keighlights', 'Key highlights'],
    ['Whyou asked for', 'What you asked for'],
    ['Recommen architecture', 'Recommended architecture'],
    ['Core entiti-', 'Core entities'],
    ['schemauggested', 'schema (suggested)'],
    ['posal', 'proposal'],
  ];

  const requests = [];

  // 1) Replace typos
  for (const [containsText, replaceText] of typoFixes) {
    requests.push({
      replaceAllText: {
        containsText: { text: containsText, matchCase: false },
        replaceText
      }
    });
  }

  // 2) Heading styling + remove markdown markers (#)
  const paragraphs = [];
  for (const el of content) {
    const p = el.paragraph;
    if (!p) continue;
    const text = (p.elements || []).map(e => e.textRun?.content || '').join('');
    paragraphs.push({ startIndex: el.startIndex, endIndex: el.endIndex, text });
  }

  for (const p of paragraphs) {
    const firstLine = (p.text || '').replace(/\r\n/g, '\n').split('\n')[0] || '';
    const m = /^(#{1,3})\s+(.*)$/.exec(firstLine.trimEnd());
    if (!m) continue;

    const hashes = m[1];
    const styleType = hashes.length === 1 ? 'TITLE' : hashes.length === 2 ? 'HEADING_1' : 'HEADING_2';
    const prefixLen = hashes.length + 1;

    // remove leading "# "
    requests.push({
      deleteContentRange: {
        range: { startIndex: p.startIndex, endIndex: p.startIndex + prefixLen }
      }
    });

    // apply style
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: p.startIndex, endIndex: p.endIndex },
        paragraphStyle: { namedStyleType: styleType },
        fields: 'namedStyleType'
      }
    });
  }

  if (!requests.length) {
    console.log(JSON.stringify({ documentId, applied: 0 }, null, 2));
    return;
  }

  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
  console.log(JSON.stringify({ documentId, applied: requests.length }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
