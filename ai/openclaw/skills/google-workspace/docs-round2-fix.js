const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Fixes:
// 1) Core features formatting: feature titles become HEADING_2 (no bullets), subpoints become bulleted + indented.
// 2) Rebuild the Architecture diagram table and fill cells bottom-up to avoid index shift garble.
//
// Usage: node docs-round2-fix.js <documentId>

function usage() {
  console.error('Usage: node docs-round2-fix.js <documentId>');
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

  // Fetch doc
  let doc = await docs.documents.get({ documentId });
  const content = doc.data.body?.content || [];

  // Identify section ranges by headings
  const headingIndex = {};
  for (const el of content) {
    if (!el.paragraph) continue;
    const line = paraText(el).split('\n')[0].trim();
    if (!line) continue;
    if (['Core features (MVP)','Nice to have (post-MVP)','Architecture diagram'].includes(line)) {
      headingIndex[line] = { startIndex: el.startIndex, endIndex: el.endIndex };
    }
  }

  const coreStart = headingIndex['Core features (MVP)']?.endIndex;
  const coreEnd = headingIndex['Nice to have (post-MVP)']?.startIndex;

  const featureTitles = new Set([
    'Timeline / slide deck',
    'Per-slide background + defaults',
    'Text frames (overlay blocks)',
    'Motion effects',
    'Preview',
    'Users and roles'
  ]);

  const requests = [];

  // Fix core section: remove bullets on feature titles and apply HEADING_2.
  if (coreStart && coreEnd && coreEnd > coreStart) {
    for (const el of content) {
      if (!el.paragraph) continue;
      if (el.startIndex < coreStart || el.startIndex >= coreEnd) continue;
      const line = paraText(el).split('\n')[0].trim();
      if (!line) continue;

      if (featureTitles.has(line)) {
        // Remove list bullet if present
        requests.push({ deleteParagraphBullets: { range: { startIndex: el.startIndex, endIndex: el.endIndex } } });
        // Apply heading 2
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: el.startIndex, endIndex: el.endIndex },
            paragraphStyle: { namedStyleType: 'HEADING_2' },
            fields: 'namedStyleType'
          }
        });
      } else {
        // Treat as sub-bullet. Ensure it's a bullet + indent.
        // First remove any existing bullets, then apply a bullet preset.
        requests.push({ deleteParagraphBullets: { range: { startIndex: el.startIndex, endIndex: el.endIndex } } });
        requests.push({ createParagraphBullets: { range: { startIndex: el.startIndex, endIndex: el.endIndex }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: el.startIndex, endIndex: el.endIndex },
            paragraphStyle: { indentStart: { magnitude: 36, unit: 'PT' } },
            fields: 'indentStart'
          }
        });
      }
    }
  }

  // Architecture diagram: delete existing table (if present) and rebuild + fill.
  // Find the last table element and its range.
  let lastTable = null;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].table) { lastTable = content[i]; break; }
  }

  if (lastTable?.startIndex && lastTable?.endIndex) {
    requests.push({ deleteContentRange: { range: { startIndex: lastTable.startIndex, endIndex: lastTable.endIndex } } });
  }

  // Insert new table right after the 'Architecture diagram' heading paragraph.
  const archHeadingEnd = headingIndex['Architecture diagram']?.endIndex;
  if (archHeadingEnd) {
    requests.push({ insertTable: { rows: 5, columns: 2, location: { index: archHeadingEnd } } });
  }

  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });

  // Re-fetch and fill table bottom-up
  doc = await docs.documents.get({ documentId });
  const c2 = doc.data.body?.content || [];
  let tableEl = null;
  for (let i = c2.length - 1; i >= 0; i--) { if (c2[i].table) { tableEl = c2[i]; break; } }
  if (!tableEl) throw new Error('Table not found after rebuild');

  const fill = [
    ['Component', 'Purpose'],
    ['Editor (web UI)', 'Create slides, place text frames, set effects, preview'],
    ['Renderer (web output)', 'Produce the final chapter experience from the saved timeline'],
    ['Media library', 'Upload and manage background images and assets'],
    ['Access + roles', 'Admin/User permissions for editing and deleting content']
  ];

  const cells = [];
  for (const row of tableEl.table.tableRows) {
    for (const cell of row.tableCells) {
      const firstPara = cell.content?.find(x => x.paragraph);
      cells.push({ startIndex: firstPara?.startIndex });
    }
  }

  const fillReq = [];
  // Build operations and sort by startIndex descending to avoid shifting
  const ops = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 2; c++) {
      const idx = r * 2 + c;
      const si = cells[idx]?.startIndex;
      const text = fill[r][c];
      if (!si || !text) continue;
      ops.push({ si, kind: 'insert', text });
      if (r === 0) ops.push({ si, kind: 'bold', len: text.length });
    }
  }
  ops.sort((a,b) => (b.si||0) - (a.si||0) || (a.kind === 'bold' ? -1 : 1));

  for (const o of ops) {
    if (o.kind === 'insert') {
      fillReq.push({ insertText: { location: { index: o.si }, text: o.text } });
    } else if (o.kind === 'bold') {
      fillReq.push({
        updateTextStyle: {
          range: { startIndex: o.si, endIndex: o.si + o.len },
          textStyle: { bold: true },
          fields: 'bold'
        }
      });
    }
  }

  await docs.documents.batchUpdate({ documentId, requestBody: { requests: fillReq } });

  console.log(JSON.stringify({ documentId, ok: true }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
