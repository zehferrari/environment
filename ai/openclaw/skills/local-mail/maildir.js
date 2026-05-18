#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HOME = os.homedir();
const USER = os.userInfo().username;
const DOMAIN = process.env.MAIL_DOMAIN || 'eurekafiles.com';
const MAILDIR = process.env.MAILDIR || path.join(HOME, 'Maildir');
const STATE_DIR = path.join(HOME, '.openclaw', 'mail');
const EVENTS = path.join(STATE_DIR, 'events.jsonl');
const DISPATCH_STATE = path.join(STATE_DIR, 'dispatch-state.json');
const POLICY_PATH = process.env.LOCAL_MAIL_POLICY || path.join(__dirname, 'auto-reply-policy.json');

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

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

function extractEmails(s) {
  return Array.from(new Set(String(s || '')
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
  )).map(normalizeEmail);
}

function loadPolicy() {
  const fallback = {
    self: { ignoreIfSenderIsSelf: true },
    reply: {
      autoReplyEmails: [],
      autoReplyDomains: [],
      neverReplyDomains: []
    }
  };
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8')) };
  } catch {
    return fallback;
  }
}

function localFromAddress() {
  return normalizeEmail(process.env.LOCAL_MAIL_FROM || `${USER}@${DOMAIN}`);
}

function policyEmails(policy) {
  return new Set((policy.reply?.autoReplyEmails || []).map(normalizeEmail));
}

function policyDomains(policy, key) {
  return new Set((policy.reply?.[key] || []).map(normalizeEmail));
}

function emailDomain(email) {
  return normalizeEmail(email).split('@')[1] || '';
}

function isAllowedEmail(email, policy = loadPolicy()) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (policy.self?.ignoreIfSenderIsSelf !== false && normalized === localFromAddress()) return false;
  const domain = emailDomain(normalized);
  if (policyDomains(policy, 'neverReplyDomains').has(domain)) return false;
  return policyEmails(policy).has(normalized) || policyDomains(policy, 'autoReplyDomains').has(domain);
}

function allowlistStatus(headerValue, policy = loadPolicy()) {
  const emails = extractEmails(headerValue);
  return {
    emails,
    allowed: emails.some(email => isAllowedEmail(email, policy))
  };
}

function assertAllowedRecipients(headerValue, action) {
  const policy = loadPolicy();
  const emails = extractEmails(headerValue);
  if (!emails.length) throw new Error(`${action}: no recipient email address found`);
  const blocked = emails.filter(email => !isAllowedEmail(email, policy));
  if (blocked.length) {
    throw new Error(`${action}: recipient outside local-mail allowlist: ${blocked.join(', ')}`);
  }
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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
  const policy = loadPolicy();
  return {
    id,
    rel,
    full,
    raw,
    headers,
    text: extractText(raw),
    unread: rel.startsWith('new/'),
    allowlist: {
      from: allowlistStatus(headers.from || '', policy),
      replyTo: allowlistStatus(headers['reply-to'] || headers.from || '', policy)
    }
  };
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
        mtimeMs: st.mtimeMs,
        allowlist: {
          from: allowlistStatus(headers.from || ''),
          replyTo: allowlistStatus(headers['reply-to'] || headers.from || '')
        }
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, Number(limit) || 20);
}

function sendMail({ to, subject, body, extraHeaders = {} }) {
  assertAllowedRecipients(to, 'send');
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

function loadDispatchState() {
  const state = readJsonFile(DISPATCH_STATE, { dispatched: {}, inflight: {}, failed: {} });
  state.dispatched ??= {};
  state.inflight ??= {};
  state.failed ??= {};
  return state;
}

function saveDispatchState(state) {
  const entries = Object.entries(state.dispatched || {})
    .sort((a, b) => (b[1].ts || '').localeCompare(a[1].ts || ''))
    .slice(0, 500);
  const inflight = Object.entries(state.inflight || {})
    .sort((a, b) => (b[1].ts || '').localeCompare(a[1].ts || ''))
    .slice(0, 100);
  const failed = Object.entries(state.failed || {})
    .sort((a, b) => (b[1].ts || '').localeCompare(a[1].ts || ''))
    .slice(0, 100);
  writeJsonFile(DISPATCH_STATE, {
    dispatched: Object.fromEntries(entries),
    inflight: Object.fromEntries(inflight),
    failed: Object.fromEntries(failed)
  });
}

function agentPrompt(message) {
  const full = readMessage(message.id);
  const body = full.text.slice(0, 12000);
  return [
    `Local email received for ${USER}.`,
    '',
    `Message ID: ${message.id}`,
    `From: ${full.headers.from || ''}`,
    `To: ${full.headers.to || ''}`,
    `Subject: ${full.headers.subject || ''}`,
    `Date: ${full.headers.date || ''}`,
    `Allowlisted sender: ${full.allowlist.from.allowed ? 'yes' : 'no'}`,
    '',
    'Body:',
    body,
    '',
    'If the sender is allowlisted and the email asks for a response or action, handle it now.',
    'Run local mail helper commands from ~/workspace/mail.',
    'To reply: cd ~/workspace/mail && node mail-reply.js <Message ID> <body>',
    'After replying or deciding no reply is needed: cd ~/workspace/mail && node mail-mark-read.js <Message ID>',
    'Do not send to recipients outside auto-reply-policy.json.'
  ].join('\n');
}

function dispatchToAgent(message) {
  const prompt = agentPrompt(message);
  appendEvent({ type: 'dispatch-start', message });
  const child = spawn('openclaw', [
    'agent',
    '--agent',
    'main',
    '--message',
    prompt,
    '--timeout',
    String(process.env.LOCAL_MAIL_AGENT_TIMEOUT || 600)
  ], {
    cwd: path.dirname(POLICY_PATH),
    env: { ...process.env, HOME },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('close', code => {
    const state = loadDispatchState();
    delete state.inflight[message.id];
    if (code === 0) {
      state.dispatched[message.id] = { ts: new Date().toISOString(), subject: message.subject };
      delete state.failed[message.id];
    } else {
      const previous = state.failed[message.id] || {};
      state.failed[message.id] = {
        ts: new Date().toISOString(),
        subject: message.subject,
        attempts: (previous.attempts || 0) + 1,
        stderr: stderr.slice(-1000)
      };
    }
    saveDispatchState(state);
    appendEvent({
      type: code === 0 ? 'dispatch-complete' : 'dispatch-failed',
      message,
      code,
      stdout: stdout.slice(-4000),
      stderr: stderr.slice(-4000)
    });
  });
}

async function watch() {
  ensureMaildir();
  console.log(JSON.stringify({ ok: true, watching: path.join(MAILDIR, 'new'), events: EVENTS }));
  function scan() {
    const state = loadDispatchState();
    const retryAfterMs = Number(process.env.LOCAL_MAIL_RETRY_AFTER_SECONDS || 300) * 1000;
    const inflightTimeoutMs = Number(process.env.LOCAL_MAIL_INFLIGHT_TIMEOUT_SECONDS || 900) * 1000;
    const now = Date.now();
    const msgs = listMessages(500).filter(m => m.unread);
    for (const m of msgs) {
      if (state.dispatched[m.id]) continue;
      const inflightAt = state.inflight[m.id]?.ts ? Date.parse(state.inflight[m.id].ts) : 0;
      if (inflightAt && now - inflightAt < inflightTimeoutMs) continue;
      if (inflightAt) {
        appendEvent({ type: 'dispatch-stale', message: m, inflight: state.inflight[m.id] });
        delete state.inflight[m.id];
      }
      const failedAt = state.failed[m.id]?.ts ? Date.parse(state.failed[m.id].ts) : 0;
      if (failedAt && now - failedAt < retryAfterMs) continue;
      state.inflight[m.id] = { ts: new Date().toISOString(), subject: m.subject };
      saveDispatchState(state);
      appendEvent({ type: 'new-mail', message: m });
      console.log(JSON.stringify({ type: 'new-mail', message: m }));
      if (m.allowlist?.from?.allowed) {
        dispatchToAgent(m);
      } else {
        delete state.inflight[m.id];
        state.dispatched[m.id] = {
          ts: new Date().toISOString(),
          subject: m.subject,
          skipped: 'sender-not-allowlisted'
        };
        saveDispatchState(state);
        appendEvent({ type: 'dispatch-skipped', reason: 'sender-not-allowlisted', message: m });
      }
    }
  }
  scan();
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
    console.log(JSON.stringify({ id: m.id, rel: m.rel, unread: m.unread, headers: m.headers, allowlist: m.allowlist, text: m.text }, null, 2));
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
