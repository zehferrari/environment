#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const USER = os.userInfo().username;
const DOMAIN = process.env.MAIL_DOMAIN || 'eurekafiles.com';
const MAILDIR = process.env.MAILDIR || path.join(HOME, 'Maildir');
const STATE_DIR = path.join(HOME, '.openclaw', 'mail');
const EVENTS = path.join(STATE_DIR, 'events.jsonl');

function ensureMaildir() {
  for (const d of ['', 'new', 'cur', 'tmp']) {
    fs.mkdirSync(path.join(MAILDIR, d), { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function encodeId(rel) {
  return Buffer.from(rel).toString('base64url');
}

function decodeId(id) {
  return Buffer.from(id, 'base64url').toString('utf8');
}

function safeHeader(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').trim();
}

function unescapeNewlines(s) {
  return String(s || '').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
}

function parseHeaders(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += ' ' + line.trim();
    } else {
      unfolded.push(line);
    }
  }

  const headers = {};
  for (const line of unfolded) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).toLowerCase();
    const v = line.slice(i + 1).trim();
    headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
  }
  return headers;
}

function splitMessage(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const idx = normalized.indexOf('\n\n');
  if (idx < 0) return { headerRaw: normalized, bodyRaw: '' };
  return { headerRaw: normalized.slice(0, idx), bodyRaw: normalized.slice(idx + 2) };
}

function decodeBody(body, encoding) {
  encoding = String(encoding || '').toLowerCase();
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (encoding === 'quoted-printable') {
    return body
      .replace(/=\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

function extractText(raw) {
  const { headerRaw, bodyRaw } = splitMessage(raw);
  const headers = parseHeaders(headerRaw);
  const contentType = headers['content-type'] || '';
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (boundary) {
    for (const part of bodyRaw.split(`--${boundary}`)) {
      const p = splitMessage(part.trim());
      const ph = parseHeaders(p.headerRaw);
      if (/text\/plain/i.test(ph['content-type'] || '')) {
        return decodeBody(p.bodyRaw, ph['content-transfer-encoding']).trim();
      }
    }
  }
  return decodeBody(bodyRaw, headers['content-transfer-encoding']).trim();
}

function messagePathFromId(id) {
  const rel = decodeId(id);
  if (rel.includes('..') || path.isAbsolute(rel)) throw new Error('invalid message id');
  const full = path.join(MAILDIR, rel);
  if (!full.startsWith(`${MAILDIR}${path.sep}`)) throw new Error('invalid message id');
  return { rel, full };
}

function readMessage(id) {
  const { rel, full } = messagePathFromId(id);
  const raw = fs.readFileSync(full, 'utf8');
  const { headerRaw } = splitMessage(raw);
  const headers = parseHeaders(headerRaw);
  return { id, rel, full, raw, headers, text: extractText(raw), unread: rel.startsWith('new/') };
}

function listMessages(limit = 20) {
  ensureMaildir();
  const out = [];
  for (const box of ['new', 'cur']) {
    const dir = path.join(MAILDIR, box);
    for (const name of fs.readdirSync(dir).filter(n => !n.startsWith('.'))) {
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const rel = `${box}/${name}`;
      let headers = {};
      try {
        headers = parseHeaders(splitMessage(fs.readFileSync(full, 'utf8')).headerRaw);
      } catch {
        headers = {};
      }
      out.push({
        id: encodeId(rel),
        rel,
        unread: box === 'new',
        from: headers.from || '',
        to: headers.to || '',
        subject: headers.subject || '(no subject)',
        date: headers.date || '',
        messageId: headers['message-id'] || '',
        mtimeMs: st.mtimeMs
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, Number(limit) || 20);
}

function sendMail({ to, subject, body, extraHeaders = {} }) {
  const from = process.env.LOCAL_MAIL_FROM || `${USER}@${DOMAIN}`;
  const msgId = `<${Date.now()}.${crypto.randomBytes(6).toString('hex')}@${os.hostname()}>`;
  const headers = [
    ['From', from],
    ['To', to],
    ['Subject', subject],
    ['Date', new Date().toUTCString()],
    ['Message-ID', msgId],
    ...Object.entries(extraHeaders).filter(([, v]) => v)
  ];
  const raw = `${headers.map(([k, v]) => `${k}: ${safeHeader(v)}`).join('\n')}\n\n${unescapeNewlines(body)}\n`;
  const child = spawnSync('/usr/sbin/sendmail', ['-oi', '-t'], { input: raw, encoding: 'utf8' });
  if (child.status !== 0) throw new Error((child.stderr || child.stdout || 'sendmail failed').trim());
  return { from, to, subject, messageId: msgId };
}

function markRead(id) {
  const { rel, full } = messagePathFromId(id);
  if (!rel.startsWith('new/')) return { id, rel, changed: false };
  const base = path.basename(rel).replace(/:2,.*$/, '');
  let dest = path.join(MAILDIR, 'cur', `${base}:2,S`);
  let n = 0;
  while (fs.existsSync(dest)) dest = path.join(MAILDIR, 'cur', `${base}.${++n}:2,S`);
  fs.renameSync(full, dest);
  return { id: encodeId(path.relative(MAILDIR, dest)), rel: path.relative(MAILDIR, dest), changed: true };
}

function appendEvent(ev) {
  ensureMaildir();
  fs.appendFileSync(EVENTS, `${JSON.stringify({ ts: new Date().toISOString(), ...ev })}\n`);
}

async function watch() {
  ensureMaildir();
  console.log(JSON.stringify({ ok: true, watching: path.join(MAILDIR, 'new'), events: EVENTS }));
  let seen = new Set(listMessages(500).map(m => m.id));
  function scan() {
    const msgs = listMessages(500).filter(m => m.unread);
    for (const m of msgs) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      appendEvent({ type: 'new-mail', message: m });
      console.log(JSON.stringify({ type: 'new-mail', message: m }));
    }
  }
  fs.watch(path.join(MAILDIR, 'new'), { persistent: true }, () => setTimeout(scan, 200));
  setInterval(scan, 30000);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'list') {
    const emails = listMessages(args[0]);
    console.log(JSON.stringify({ count: emails.length, emails }, null, 2));
    return;
  }
  if (cmd === 'check') {
    const emails = listMessages(500).filter(m => m.unread);
    console.log(JSON.stringify({ unread: emails.length, emails }, null, 2));
    return;
  }
  if (cmd === 'get') {
    const m = readMessage(args[0]);
    console.log(JSON.stringify({ id: m.id, rel: m.rel, unread: m.unread, headers: m.headers, text: m.text }, null, 2));
    return;
  }
  if (cmd === 'mark-read') {
    console.log(JSON.stringify(markRead(args[0]), null, 2));
    return;
  }
  if (cmd === 'send') {
    const [to, subject, ...body] = args;
    if (!to || !subject || !body.length) throw new Error('usage: send <to> <subject> <body>');
    console.log(JSON.stringify(sendMail({ to, subject, body: body.join(' ') }), null, 2));
    return;
  }
  if (cmd === 'reply') {
    const [id, ...body] = args;
    if (!id || !body.length) throw new Error('usage: reply <messageId> <body>');
    const m = readMessage(id);
    const to = m.headers['reply-to'] || m.headers.from;
    const subject = /^re:/i.test(m.headers.subject || '') ? m.headers.subject : `Re: ${m.headers.subject || ''}`;
    const refs = [m.headers.references, m.headers['message-id']].filter(Boolean).join(' ');
    console.log(JSON.stringify(sendMail({
      to,
      subject,
      body: body.join(' '),
      extraHeaders: { 'In-Reply-To': m.headers['message-id'] || '', References: refs }
    }), null, 2));
    return;
  }
  if (cmd === 'watch') {
    await watch();
    return;
  }
  throw new Error('usage: maildir.js <list|check|get|mark-read|send|reply|watch>');
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
