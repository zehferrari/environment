const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Appends a simple architecture table diagram to the end of the doc and fills it.
// Usage: node docs-add-architecture-table.js <documentId>

function usage() {
  console.error('Usage: node docs-add-architecture-table.js <documentId>');
  process.exit(1);
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId) usage();

  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  // Get end index
  let doc = await docs.documents.get({ documentId });
  const bodyContent = doc.data.body?.content || [];
  const endIndex = bodyContent[bodyContent.length - 1]?.endIndex || 1;
  const insertAt = Math.max(1, endIndex - 1);

  const headingText = '\nArchitecture diagram\n';

  // Insert heading + table
  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        { insertText: { location: { index: insertAt }, text: headingText } },
        {
          updateParagraphStyle: {
            range: { startIndex: insertAt, endIndex: insertAt + headingText.length },
            paragraphStyle: { namedStyleType: 'HEADING_1' },
            fields: 'namedStyleType'
          }
        },
        { insertTable: { rows: 5, columns: 2, location: { index: insertAt + headingText.length } } }
      ]
    }
  });

  // Re-fetch to find the inserted table
  doc = await docs.documents.get({ documentId });
  const content = doc.data.body?.content || [];

  // Find the last table in the document
  let tableEl = null;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].table) { tableEl = content[i]; break; }
  }
  if (!tableEl) throw new Error('Table not found after insertion');

  const cells = [];
  for (const row of tableEl.table.tableRows) {
    for (const cell of row.tableCells) {
      // Cell content usually starts with a paragraph element at some startIndex
      const first = cell.content?.find(x => x.paragraph);
      if (!first) cells.push(null);
      else cells.push({ startIndex: first.startIndex });
    }
  }

  // Fill text into 5x2 = 10 cells
  const fill = [
    ['Component', 'What it does'],
    ['Editor (web UI)', 'Create slides, place text frames, set effects, preview'],
    ['Renderer (web output)', 'Turns the timeline schema into the final chapter page'],
    ['Media storage', 'Holds background images and any uploaded assets'],
    ['User access', 'Login + roles (Admin/User) for who can edit/delete']
  ];

  const requests = [];
  for (let r = 0; r < fill.length; r++) {
    for (let c = 0; c < fill[r].length; c++) {
      const idx = r * 2 + c;
      const cell = cells[idx];
      if (!cell?.startIndex) continue;
      requests.push({
        insertText: { location: { index: cell.startIndex }, text: fill[r][c] }
      });
      // Bold header row
      if (r === 0) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: cell.startIndex, endIndex: cell.startIndex + fill[r][c].length },
            textStyle: { bold: true },
            fields: 'bold'
          }
        });
      }
    }
  }

  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
  console.log(JSON.stringify({ documentId, ok: true, filledCells: requests.length }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
