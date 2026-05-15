#!/usr/bin/env node
/*
Wrapper for docs-comments-cron-all.js that enforces Telegram START/DONE notifications
ONLY when trigger conditions are met.

- If no candidates: updates state.lastScanTime=now and exits with no stdout.
- If candidates: prints nothing itself; sends START/DONE via OpenClaw main session (handled outside).

This wrapper is intended to be run from OpenClaw (not directly from cron) so the
assistant can decide whether to send user-facing notifications.
*/

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuth } = require('./lib');

const ALLOWED_AUTHORS = new Set(['Zeh Ferrari', 'Rachael Smith']);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function isoNow() { return new Date().toISOString(); }

function ms(t) {
  const v = Date.parse(t);
  return Number.isFinite(v) ? v : NaN;
}

async function listAllDocs(drive) {
  const q = "mimeType='application/vnd.google-apps.document' and trashed=false";
  let pageToken = undefined;
  const files = [];
  do {
    const res = await drive.files.list({
      q,
      pageSize: 100,
      pageToken,
      fields: 'nextPageToken,files(id,name,modifiedTime,owners(displayName,emailAddress),webViewLink)'
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return files;
}

async function listComments(drive, fileId) {
  let pageToken = undefined;
  const comments = [];
  do {
    const res = await drive.comments.list({
      fileId,
      pageSize: 100,
      pageToken,
      fields: 'nextPageToken,comments(id,createdTime,modifiedTime,author(displayName,emailAddress),content,deleted,quotedFileContent,resolved)'
    });
    comments.push(...(res.data.comments || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return comments;
}

async function main() {
  const statePathArg = process.argv[2];
  if (!statePathArg) {
    console.error('Usage: node docs-comments-cron-all-wrapper.js <statePath>');
    process.exit(1);
  }
  const statePath = path.resolve(statePathArg);

  const state = readJson(statePath, { lastScanTime: null, handledCommentIds: {} });
  state.handledCommentIds = state.handledCommentIds || {};

  const lastScanMs = ms(state.lastScanTime);
  const lastScanCutoff = Number.isFinite(lastScanMs) ? lastScanMs : 0;

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const docs = await listAllDocs(drive);

  let found = false;
  for (const f of docs) {
    const comments = await listComments(drive, f.id);
    for (const c of comments) {
      if (!c || c.deleted) continue;
      const commentId = c.id;
      if (!commentId) continue;

      const author = c.author?.displayName || '';
      const modifiedTime = c.modifiedTime;

      // ABSOLUTE TRIGGER RULES
      if (!ALLOWED_AUTHORS.has(author)) continue;                 // A
      if (!(ms(modifiedTime) > lastScanCutoff)) continue;         // B
      if (state.handledCommentIds[String(commentId)]) continue;   // C

      found = true;
      break;
    }
    if (found) break;
  }

  if (!found) {
    state.lastScanTime = isoNow();
    writeJsonAtomic(statePath, state);
    return;
  }

  // Candidate(s) exist — print a one-line sentinel so caller can send START/DONE.
  process.stdout.write('TRIGGERED\n');
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
