const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuth } = require('./lib');

// Export a Google Doc to PDF.
// Usage: node drive-export-pdf.js <fileId> <outPath>

function usage() {
  console.error('Usage: node drive-export-pdf.js <fileId> <outPath>');
  process.exit(1);
}

async function main() {
  const [fileId, outPath] = process.argv.slice(2);
  if (!fileId || !outPath) usage();

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.export(
    { fileId, mimeType: 'application/pdf' },
    { responseType: 'arraybuffer' }
  );

  const outAbs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, Buffer.from(res.data));
  console.log(JSON.stringify({ ok: true, fileId, outPath: outAbs, bytes: fs.statSync(outAbs).size }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
