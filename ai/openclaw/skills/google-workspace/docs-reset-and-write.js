const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Deletes all body content of a Google Doc and writes a fresh, styled first draft.
// Usage: node docs-reset-and-write.js <documentId>

function usage() {
  console.error('Usage: node docs-reset-and-write.js <documentId>');
  process.exit(1);
}

const TEXT = [
  'Whitsunday Discovery Trail - New WebApp (Timeline Editor)\n',
  '\n',
  'Overview\n',
  'We are building a web-based editor to create story-driven chapter experiences like:\n',
  'https://eurekafiles.com/seagrass-chapter/\n',
  '\n',
  'The editor is designed for non-technical users. It lets them assemble a timeline (a slide deck of scenes) with visuals, text overlays, and motion effects, then preview the final web experience.\n',
  '\n',
  'Goals\n',
  '- Make it fast to create and maintain chapters with consistent style.\n',
  '- Keep the tool easy for non-technical editors, with optional advanced controls.\n',
  '- Produce a clean web output that matches preview (no surprises).\n',
  '\n',
  'Core features (MVP)\n',
  '1) Timeline / slide deck\n',
  '- Create, reorder, and edit slides (scenes).\n',
  '- Each slide represents a section of the story the visitor scrolls through.\n',
  '\n',
  '2) Per-slide background + defaults\n',
  '- Each slide can have its own background image.\n',
  '- If a slide does not set a background, a default background can be applied.\n',
  '\n',
  '3) Text frames (overlay blocks)\n',
  '- Add as many text frames as needed per slide.\n',
  '- Shapes: bubble, drop, square, rectangle (more can be added later).\n',
  '- Styling: background colour or gradient, transparency, borders, and simple shadows.\n',
  '\n',
  '4) Motion effects\n',
  '- Scroll effects per slide (for example: floating bubbles).\n',
  '- Transition effects between slides (for example: parallax, zoom, pan, flip, fade).\n',
  '- Defaults can be set so new slides inherit the same behaviour.\n',
  '\n',
  '5) Preview\n',
  '- One-click preview that renders the chapter the same way users will see it.\n',
  '\n',
  '6) Users and roles\n',
  '- Two roles initially: Admin and User.\n',
  '- Admin can manage who has access and can delete content.\n',
  '\n',
  'Advanced (optional, not required for MVP)\n',
  '- Advanced mode to view and edit the underlying JSON schema for experienced users.\n',
  '- Search across chapters and slides (Elasticsearch can be used later).\n',
  '\n',
  'Open questions\n',
  '1) Media scope: do we start with text + images only, or include video/audio in the first version?\n',
  '2) Effects scope: should effects stay lightweight (CSS/JS) for MVP, with heavier effects later if needed?\n',
  '3) Languages: single language for MVP, or do we need multi-language content per slide?\n',
  '\n',
  'Next steps\n',
  '- Confirm the open questions above.\n',
  '- Finalise the MVP feature list and visual defaults.\n',
  '- Implement the editor + preview in small deliverable phases.\n'
].join('');

async function main() {
  const documentId = process.argv[2];
  if (!documentId) usage();

  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  const doc = await docs.documents.get({ documentId });
  const body = doc.data.body;
  const endIndex = body?.content?.[body.content.length - 1]?.endIndex;

  const requests = [];

  // Delete existing content but keep the initial newline.
  if (typeof endIndex === 'number' && endIndex > 2) {
    requests.push({
      deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } }
    });
  }

  // Insert fresh text
  requests.push({ insertText: { location: { index: 1 }, text: TEXT } });

  // Apply styles by paragraph (best effort using ranges inferred from the inserted text)
  // Title: first line
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: 1, endIndex: 1 + 'Whitsunday Discovery Trail - New WebApp (Timeline Editor)'.length + 1 },
      paragraphStyle: { namedStyleType: 'TITLE' },
      fields: 'namedStyleType'
    }
  });

  // Helper: style headings by replacing exact heading lines with named styles.
  const headingLines = [
    'Overview',
    'Goals',
    'Core features (MVP)',
    'Advanced (optional, not required for MVP)',
    'Open questions',
    'Next steps'
  ];

  for (const h of headingLines) {
    requests.push({
      replaceAllText: {
        containsText: { text: `\n${h}\n`, matchCase: true },
        replaceText: `\n${h}\n`
      }
    });
  }

  // NOTE: We keep styling minimal and safe here. A second pass (docs-style-headings.js)
  // scans paragraphs and applies heading styles safely without breaking comment anchors.

  await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
  console.log(JSON.stringify({ documentId, ok: true }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
