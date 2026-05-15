const { google } = require('googleapis');
const { getAuth } = require('./lib');

// In-place polish based on Zeh feedback:
// - Make 'Preview' a proper section heading (HEADING_2) and ensure it's not a bullet.
// - Fix small grammar issues.
// - Keep Advanced mode in v1, but clarify it's a simple textarea JSON editor.
//
// Usage: node docs-polish-zeh-latest.js <documentId>

function usage() {
  console.error('Usage: node docs-polish-zeh-latest.js <documentId>');
  process.exit(1);
}

function paraText(el) {
  const t = (el.paragraph.elements || []).map(e => e.textRun?.content || '').join('');
  return (t || '').replace(/\r\n/g, '\n');
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId) usage();

  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  const doc = await docs.documents.get({ documentId });
  const content = doc.data.body?.content || [];

  let previewPara = null;
  for (const el of content) {
    if (!el.paragraph) continue;
    const line = paraText(el).split('\n')[0].trim();
    if (line === 'Preview') { previewPara = el; break; }
  }

  const requests = [];

  // Grammar
  requests.push({
    replaceAllText: {
      containsText: { text: 'Admin can manage users access', matchCase: false },
      replaceText: 'Admin can manage user access'
    }
  });

  // Advanced mode wording: keep it in v1, but clarify
  requests.push({
    replaceAllText: {
      containsText: { text: 'Advanced mode: view/edit the underlying schema (for power users).', matchCase: true },
      replaceText: 'Advanced mode: a simple JSON editor (textarea) to view/edit the schema.'
    }
  });

  // Preview heading styling
  if (previewPara?.startIndex && previewPara?.endIndex) {
    // Ensure no bullets
    requests.push({
      deleteParagraphBullets: {
        range: { startIndex: previewPara.startIndex, endIndex: previewPara.endIndex }
      }
    });
    // Heading 2
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: previewPara.startIndex, endIndex: previewPara.endIndex },
        paragraphStyle: { namedStyleType: 'HEADING_2' },
        fields: 'namedStyleType'
      }
    });
  }

  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
  console.log(JSON.stringify({ documentId, ok: true, previewFound: !!previewPara }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
