const { execSync } = require('child_process');

// Basic PDF QC using pdftotext + heuristics.
// Usage: node pdf-qc.js <pdfPath>

function usage() {
  console.error('Usage: node pdf-qc.js <pdfPath>');
  process.exit(1);
}

function readText(pdfPath) {
  // -layout preserves spacing; better for spotting garble.
  const cmd = `pdftotext -layout "${pdfPath.replace(/"/g, '\\"')}" -`;
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
}

function findIssues(text) {
  const issues = [];

  // Funny characters / replacement glyphs
  if (text.includes('�')) issues.push('Contains replacement character (�)');

  // Common garble pattern: words jammed together for table rows
  if (/\b[A-Za-z]{2,}(?:[A-Z][a-z]{1,}){3,}\b/.test(text)) {
    issues.push('Possible jammed words (table/formatting garble)');
  }

  // Headings accidentally duplicated or missing spacing (very rough)
  if (/\n\s*\d+\.\s*\n\s*●/m.test(text)) {
    issues.push('Numbered list item appears to have blank title line');
  }

  // Super long lines often indicate layout issues
  const longLine = text.split(/\r?\n/).some(l => l.length > 180);
  if (longLine) issues.push('Very long line detected (possible layout issue)');

  return issues;
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) usage();

  let text;
  try {
    text = readText(pdfPath);
  } catch (e) {
    console.error(String(e));
    process.exit(2);
  }

  const issues = findIssues(text);
  console.log(JSON.stringify({ ok: issues.length === 0, issues, sample: text.slice(0, 1200) }, null, 2));
}

main();
