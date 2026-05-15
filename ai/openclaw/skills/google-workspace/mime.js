function b64url(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toAsciiBasic(s) {
  // Map common “smart” punctuation to plain ASCII, then strip remaining non-ASCII.
  return String(s ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00a0/g, ' ') // NBSP
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function sanitizeEmailText(text) {
  let t = String(text ?? '');
  // Common artifact when copying from terminals/CLIs: accidental leading "$" prompt marker.
  // Only strip if it appears at the very start of the message (or start of a new paragraph)
  // and is followed by a letter (so we don't break currency amounts like "$5").
  t = t.replace(/(^|\n\n+)\$([A-Za-z])/g, (_, pfx, ch) => `${pfx}${ch}`);
  // Normalize newlines
  t = t.replace(/\r\n/g, '\n');
  // Enforce basic ASCII for now
  t = toAsciiBasic(t);
  return t.trimEnd();
}

// Detect a trailing signature paragraph of the form:
//     --
//     <First Name>
//     <provider>/<model>
// and render the provider/model line subdued (smaller + grey) per
// TEAM_WORKFLOW.md Outbound Signature Rule. Plain text part is unchanged.
const SIG_PARA_RE = /^--\n([^\n]+)\n([^\n]+\/[^\n]+)$/;

function paragraphToHtml(p) {
  const sig = SIG_PARA_RE.exec(p);
  if (sig) {
    const name = escapeHtml(sig[1].trim());
    const pm = escapeHtml(sig[2].trim());
    return `<p>--<br>${name}<br><span style="color:#888;font-size:smaller;font-style:italic;">${pm}</span></p>`;
  }
  return `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`;
}

function textToHtml(text) {
  const clean = sanitizeEmailText(text);
  const paras = clean.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const htmlParas = paras.map(paragraphToHtml).join('\n');
  return `<!doctype html><html><body>${htmlParas}</body></html>`;
}

function sanitizeHeaderValue(v) {
  // Keep headers ASCII-only (avoids mojibake in clients that don't decode RFC2047 properly).
  // If we later want full Unicode subjects, we should implement RFC 2047 encoded-words.
  return toAsciiBasic(v).replace(/[\r\n]/g, ' ').trim();
}

function buildMultipartAlternative({ from, to, subject, text, extraHeaders = {} }) {
  const boundary = `----=_OpenClaw_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const headers = [
    `From: ${sanitizeHeaderValue(from)}`,
    `To: ${sanitizeHeaderValue(to)}`,
    `Subject: ${sanitizeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v) headers.push(`${k}: ${v}`);
  }

  const cleanText = sanitizeEmailText(text);
  const html = textToHtml(cleanText);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    cleanText,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    `--${boundary}--`,
    '',
  ];

  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

module.exports = { b64url, buildMultipartAlternative, textToHtml };
