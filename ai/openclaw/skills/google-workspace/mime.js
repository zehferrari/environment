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

// ─── Sender identity ──────────────────────────────────────────────────────
//
// Build the From: header for the running agent — pulled from
// /etc/openclaw/agents.json by os.userInfo().username. Per
// TEAM_WORKFLOW.md "Email sender header (mandatory)", every outbound
// email must use "Name <email>", never bare address. Inlined here
// (instead of require('../agent-self')) so gmail-send.js / gmail-reply.js
// are self-contained and can be deployed as copies to each agent's
// workspace/google/ without setting up extra symlinks.
const fs = require('fs');
const os = require('os');

function _agentRecord() {
  const path = process.env.OPENCLAW_AGENTS_JSON || '/etc/openclaw/agents.json';
  const reg = JSON.parse(fs.readFileSync(path, 'utf8'));
  const u = os.userInfo().username;
  const a = (reg.agents || []).find(x => x.user === u);
  if (!a) throw new Error(`mime: no agent registered for user "${u}" in ${path}`);
  return a;
}

function fromHeader() {
  const a = _agentRecord();
  if (!a.name || !a.email) {
    throw new Error(`mime: cannot build From header — missing name (${a.name || 'unset'}) or email (${a.email || 'unset'}) for user "${a.user}" in agents.json`);
  }
  return `${a.name} <${a.email}>`;
}

// ─── Body argument parsing ─────────────────────────────────────────────────
//
// Three ways for callers to supply an email body:
//   - literal:     positional argument(s) joined as the message text
//   - --body-file: read body from a file
//   - "-":         read body from stdin
//
// Path-guard: refuses to send when the body is a single positional that
// matches an absolute path AND that path is an existing file. That's the
// bug that produced "the recipient got an email saying /tmp/reply_*.txt"
// — the agent meant --body-file but passed the path bare. Surface the
// mistake instead of silently sending the wrong content.
function parseBodyArgs(positional) {
  let bodyFile = null;
  const rest = [];
  for (let i = 0; i < positional.length; i++) {
    const a = positional[i];
    if (a === '--body-file' || a === '-f') {
      bodyFile = positional[++i];
      if (!bodyFile) throw new Error('--body-file requires a path');
    } else if (a.startsWith('--body-file=')) {
      bodyFile = a.slice('--body-file='.length);
    } else {
      rest.push(a);
    }
  }
  if (bodyFile) {
    if (!fs.existsSync(bodyFile)) throw new Error(`--body-file path does not exist: ${bodyFile}`);
    return { body: fs.readFileSync(bodyFile, 'utf8').trim(), rest };
  }
  if (rest.length === 1 && rest[0] === '-') {
    return { body: fs.readFileSync(0, 'utf8').trim(), rest: [] };
  }
  if (rest.length === 0) return { body: '', rest };
  const raw = rest.join(' ').trim();
  if (rest.length === 1
      && /^\/[^\s]+$/.test(raw)
      && fs.existsSync(raw)
      && fs.statSync(raw).isFile()) {
    throw new Error(
      `Body "${raw}" looks like a path to an existing file, but the ` +
      `body is taken literally as the message contents. Use ` +
      `--body-file=${raw} to send the file contents instead.`
    );
  }
  return { body: raw, rest };
}

module.exports = { b64url, buildMultipartAlternative, textToHtml, fromHeader, parseBodyArgs };
