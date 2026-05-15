const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Rebuilds the WDT Timeline Editor plan doc from scratch with proper Google Docs formatting:
// - Title + headings
// - Real bulleted and numbered lists (no manual '-' or '1.')
// - Visual element: a clean table-based diagram (shaded header)
// - No open questions in body; questions will be added as a Drive comment
//
// Usage: node docs-rebuild-wdt-plan.js <documentId>

function usage() {
  console.error('Usage: node docs-rebuild-wdt-plan.js <documentId>');
  process.exit(1);
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId) usage();

  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  // Helper to get paragraphs with indices
  const getParagraphs = async () => {
    const doc = await docs.documents.get({ documentId });
    const content = doc.data.body?.content || [];
    const paras = [];
    for (const el of content) {
      if (!el.paragraph) continue;
      const text = (el.paragraph.elements || []).map(e => e.textRun?.content || '').join('');
      const line = (text || '').replace(/\r\n/g, '\n').split('\n')[0].trim();
      paras.push({ startIndex: el.startIndex, endIndex: el.endIndex, line, raw: text });
    }
    return { doc, paras };
  };

  // 1) wipe body
  let { doc } = await getParagraphs();
  const endIndex = doc.data.body?.content?.[doc.data.body.content.length - 1]?.endIndex;
  const wipeReq = [];
  if (typeof endIndex === 'number' && endIndex > 2) {
    wipeReq.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }

  // 2) insert fresh text WITHOUT manual list markers
  const blocks = [
    { type: 'TITLE', text: 'Whitsunday Discovery Trail - New WebApp (Timeline Editor)' },
    { type: 'H1', text: 'Overview' },
    { type: 'P', text: 'We are building a web-based editor to create story-driven chapter experiences like the Seagrass example chapter. The editor targets non-technical users and focuses on creating a timeline (a slide deck of scenes) with consistent style, motion, and preview.' },
    { type: 'P', text: 'Reference: https://eurekafiles.com/seagrass-chapter/' },

    { type: 'H1', text: 'Goals' },
    { type: 'BULLET', text: 'Fast to create and update chapters with consistent visual style.' },
    { type: 'BULLET', text: 'Easy for non-technical editors, with optional advanced controls later.' },
    { type: 'BULLET', text: 'Preview matches the final output (no surprises).' },

    { type: 'H1', text: 'Core features (MVP)' },
    { type: 'NUM', text: 'Timeline / slide deck' },
    { type: 'SUBBULLET', text: 'Create, reorder, and edit slides (scenes).' },
    { type: 'SUBBULLET', text: 'Each slide represents a section of the story the visitor scrolls through.' },

    { type: 'NUM', text: 'Per-slide background + defaults' },
    { type: 'SUBBULLET', text: 'Each slide can have its own background image.' },
    { type: 'SUBBULLET', text: 'Deck-level defaults apply when a slide does not set its own background.' },

    { type: 'NUM', text: 'Text frames (overlay blocks)' },
    { type: 'SUBBULLET', text: 'Add multiple text frames per slide.' },
    { type: 'SUBBULLET', text: 'Shapes: bubble, drop, rectangle (expand later).' },
    { type: 'SUBBULLET', text: 'Basic styling: background colour or gradient, transparency, border, shadow.' },

    { type: 'NUM', text: 'Motion effects' },
    { type: 'SUBBULLET', text: 'Scroll effects per slide (for example: floating bubbles).' },
    { type: 'SUBBULLET', text: 'Transitions between slides (for example: parallax, zoom, pan, fade).' },
    { type: 'SUBBULLET', text: 'Defaults so new slides inherit the chosen behaviour.' },

    { type: 'NUM', text: 'Preview' },
    { type: 'SUBBULLET', text: 'One-click preview that renders the chapter as visitors will see it.' },

    { type: 'NUM', text: 'Users and roles' },
    { type: 'SUBBULLET', text: 'Two roles initially: Admin and User.' },
    { type: 'SUBBULLET', text: 'Admin can manage access and delete content.' },

    { type: 'H1', text: 'Nice to have (post-MVP)' },
    { type: 'BULLET', text: 'Advanced mode: view/edit the underlying schema (for power users).' },
    { type: 'BULLET', text: 'Search across chapters and slides (optional later).' },

    { type: 'H1', text: 'Next steps' },
    { type: 'BULLET', text: 'Confirm MVP scope (media types, effect complexity, languages).' },
    { type: 'BULLET', text: 'Agree on a default visual theme (fonts, colours, spacing).' },
    { type: 'BULLET', text: 'Build the editor and preview in small deliverable phases.' },

    { type: 'H1', text: 'Architecture diagram' },
    { type: 'TABLE', text: '' }
  ];

  const insertText = (t) => `${t}\n`;
  let fullText = '';
  for (const b of blocks) {
    if (b.type === 'TABLE') continue;
    fullText += insertText(b.text);
    if (b.type === 'TITLE') fullText += '\n';
  }

  const req = [...wipeReq];
  req.push({ insertText: { location: { index: 1 }, text: fullText } });

  await docs.documents.batchUpdate({ documentId, requestBody: { requests: req } });

  // 3) apply paragraph styles + lists by scanning the doc
  const { paras } = await getParagraphs();

  const requests = [];

  // Title style
  const titlePara = paras.find(p => p.line === blocks[0].text);
  if (titlePara) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: titlePara.startIndex, endIndex: titlePara.endIndex },
        paragraphStyle: { namedStyleType: 'TITLE' },
        fields: 'namedStyleType'
      }
    });
  }

  // Heading 1s
  const headings = blocks.filter(b => b.type === 'H1').map(b => b.text);
  for (const p of paras) {
    if (headings.includes(p.line)) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: p.startIndex, endIndex: p.endIndex },
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          fields: 'namedStyleType'
        }
      });
    }
  }

  // Bullets: group contiguous bullet paragraphs into ranges
  const bulletTexts = new Set(blocks.filter(b => b.type === 'BULLET').map(b => b.text));
  const subBulletTexts = new Set(blocks.filter(b => b.type === 'SUBBULLET').map(b => b.text));
  const numTexts = new Set(blocks.filter(b => b.type === 'NUM').map(b => b.text));

  const rangesFor = (set) => {
    const matches = paras
      .filter(p => set.has(p.line))
      .sort((a,b) => a.startIndex - b.startIndex);
    const ranges = [];
    let cur = null;
    for (const m of matches) {
      if (!cur) cur = { startIndex: m.startIndex, endIndex: m.endIndex };
      else if (m.startIndex <= cur.endIndex + 1) cur.endIndex = m.endIndex;
      else { ranges.push(cur); cur = { startIndex: m.startIndex, endIndex: m.endIndex }; }
    }
    if (cur) ranges.push(cur);
    return ranges;
  };

  // Apply bullets
  for (const r of rangesFor(bulletTexts)) {
    requests.push({ createParagraphBullets: { range: r, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
  }

  // Apply numbered list (single contiguous range across all NUM items)
  const numMatches = paras.filter(p => numTexts.has(p.line)).sort((a,b)=>a.startIndex-b.startIndex);
  if (numMatches.length) {
    const r = { startIndex: numMatches[0].startIndex, endIndex: numMatches[numMatches.length-1].endIndex };
    requests.push({ createParagraphBullets: { range: r, bulletPreset: 'NUMBERED_DECIMAL_NESTED' } });
  }

  // Apply sub-bullets
  for (const r of rangesFor(subBulletTexts)) {
    requests.push({ createParagraphBullets: { range: r, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
    // Indent sub-bullets
    requests.push({
      updateParagraphStyle: {
        range: r,
        paragraphStyle: { indentStart: { magnitude: 36, unit: 'PT' } },
        fields: 'indentStart'
      }
    });
  }

  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });

  // 4) Add and fill a clean table under Architecture diagram heading
  // Re-fetch to find the Architecture diagram paragraph endIndex
  const afterStyle = await docs.documents.get({ documentId });
  const c2 = afterStyle.data.body?.content || [];
  let archPara = null;
  for (const el of c2) {
    if (!el.paragraph) continue;
    const t = (el.paragraph.elements || []).map(e => e.textRun?.content || '').join('');
    const line = (t || '').replace(/\r\n/g,'\n').split('\n')[0].trim();
    if (line === 'Architecture diagram') { archPara = el; break; }
  }

  const insertAt = Math.max(1, (archPara?.endIndex || (c2[c2.length-1]?.endIndex || 1)) - 1);
  await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests: [ { insertTable: { rows: 5, columns: 2, location: { index: insertAt } } } ] }
  });

  // Fill last table
  const afterTable = await docs.documents.get({ documentId });
  const c3 = afterTable.data.body?.content || [];
  let tableEl = null;
  for (let i = c3.length - 1; i >= 0; i--) { if (c3[i].table) { tableEl = c3[i]; break; } }
  if (!tableEl) throw new Error('Table not found');

  const fill = [
    ['Component', 'Purpose'],
    ['Editor (web UI)', 'Create slides, place text frames, set effects, preview'],
    ['Renderer (web output)', 'Produces the final chapter experience from the saved timeline'],
    ['Media library', 'Upload and manage background images and assets'],
    ['Access + roles', 'Admin/User permissions for editing and deleting content']
  ];

  const fillReq = [];
  for (let r = 0; r < tableEl.table.tableRows.length; r++) {
    const row = tableEl.table.tableRows[r];
    for (let c = 0; c < row.tableCells.length; c++) {
      const cell = row.tableCells[c];
      const firstPara = cell.content?.find(x => x.paragraph);
      if (!firstPara) continue;
      const text = fill[r]?.[c] || '';
      if (!text) continue;
      fillReq.push({ insertText: { location: { index: firstPara.startIndex }, text } });
      if (r === 0) {
        fillReq.push({
          updateTextStyle: {
            range: { startIndex: firstPara.startIndex, endIndex: firstPara.startIndex + text.length },
            textStyle: { bold: true },
            fields: 'bold'
          }
        });
      }
    }
  }

  await docs.documents.batchUpdate({ documentId, requestBody: { requests: fillReq } });

  console.log(JSON.stringify({ documentId, ok: true }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
