#!/usr/bin/env node
/*
Monitor Google Docs comments across ALL visible Google Docs.

Implements:
- Absolute trigger rules (author allowlist + modifiedTime > state.lastScanTime + commentId not handled)
- Dedupe: if any reply by self (current agent) exists with createdTime >= comment.modifiedTime, do not reply
- Workflow (best-effort): edit doc in place -> export PDF -> QC PDF (up to 3 tries)
- End: always update state.lastScanTime

Usage:
  node docs-comments-monitor-all.js --state /abs/path/to/state.json [--scan-only]

Output: JSON summary to stdout.
*/

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuth } = require('./lib');
const self = require('../agent-self');

const ALLOWED_AUTHORS = new Set(['Zeh Ferrari', 'Rachael Smith']);
// Self identities for dedupe (resolved from /etc/openclaw/agents.json by current user)
const SELF_DISPLAYNAMES = new Set([self.name]);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] || null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

function isoNow() { return new Date().toISOString(); }

function gtIso(a, b) {
  // a > b (ISO strings)
  return String(a).localeCompare(String(b)) > 0;
}

async function listAllDocs(drive) {
  const docs = [];
  let pageToken = undefined;
  do {
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.document' and trashed=false",
      fields: 'nextPageToken,files(id,name,webViewLink,modifiedTime,owners(displayName,emailAddress))',
      pageSize: 1000,
      orderBy: 'modifiedTime desc',
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    docs.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return docs;
}

async function listAllComments(drive, fileId) {
  const comments = [];
  let pageToken = undefined;
  do {
    const res = await drive.comments.list({
      fileId,
      pageSize: 100,
      fields: 'nextPageToken,comments(id,createdTime,modifiedTime,author(displayName,emailAddress),content,deleted,resolved,quotedFileContent)'
    });
    comments.push(...(res.data.comments || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return comments;
}

async function listReplies(drive, fileId, commentId) {
  const replies = [];
  let pageToken = undefined;
  do {
    const res = await drive.replies.list({
      fileId,
      commentId,
      fields: 'nextPageToken,replies(id,createdTime,modifiedTime,author(displayName,emailAddress),content,deleted)'
    });
    replies.push(...(res.data.replies || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return replies;
}

function extractReplaceInstruction(commentText) {
  const t = String(commentText || '').trim();
  // Common patterns:
  // 1) change "A" to "B"
  // 2) replace "A" with "B"
  // 3) s/A/B/ (very light)
  let m = t.match(/\bchange\s+"([\s\S]+?)"\s+to\s+"([\s\S]+?)"\b/i);
  if (m) return { from: m[1], to: m[2], kind: 'change' };
  m = t.match(/\breplace\s+"([\s\S]+?)"\s+with\s+"([\s\S]+?)"\b/i);
  if (m) return { from: m[1], to: m[2], kind: 'replace' };
  m = t.match(/^s\/(.+)\/(.+)\/?$/);
  if (m) return { from: m[1], to: m[2], kind: 'sed' };
  return null;
}

async function applyDocEdit(docsApi, documentId, comment) {
  const instruction = extractReplaceInstruction(comment.content);
  if (!instruction) {
    return { edited: false, reason: 'no_clear_instruction' };
  }

  const requests = [{
    replaceAllText: {
      containsText: { text: instruction.from, matchCase: false },
      replaceText: instruction.to
    }
  }];

  const res = await docsApi.documents.batchUpdate({
    documentId,
    requestBody: { requests }
  });

  const changed = (res.data.replies || []).some(r => r.replaceAllText && typeof r.replaceAllText.occurrencesChanged === 'number' ? r.replaceAllText.occurrencesChanged > 0 : false);

  return {
    edited: true,
    instruction,
    occurrencesChanged: (res.data.replies || []).map(r => r.replaceAllText?.occurrencesChanged).filter(x => typeof x === 'number')[0] ?? null,
    changed
  };
}

async function exportPdf(drive, fileId, outPath) {
  const res = await drive.files.export(
    { fileId, mimeType: 'application/pdf' },
    { responseType: 'arraybuffer' }
  );
  const outAbs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, Buffer.from(res.data));
  const st = fs.statSync(outAbs);
  return { outPath: outAbs, bytes: st.size };
}

function qcPdf(outPath) {
  try {
    const st = fs.statSync(outPath);
    if (st.size < 1500) return { ok: false, reason: 'too_small', bytes: st.size };
    const hdr = fs.readFileSync(outPath, { encoding: null, flag: 'r' }).subarray(0, 8).toString('utf8');
    if (!hdr.startsWith('%PDF-')) return { ok: false, reason: 'not_pdf_header', header: hdr };
    return { ok: true, bytes: st.size };
  } catch (e) {
    return { ok: false, reason: 'exception', error: String(e) };
  }
}

function shouldTrigger(state, comment) {
  const authorName = comment.author?.displayName || '';
  if (!ALLOWED_AUTHORS.has(authorName)) return false;
  const modifiedTime = comment.modifiedTime || comment.createdTime;
  if (!modifiedTime) return false;
  if (!gtIso(modifiedTime, state.lastScanTime || '')) return false;
  if (state.handledCommentIds && state.handledCommentIds[String(comment.id)]) return false;
  return true;
}

function hasSelfReplyAfter(replies, commentModifiedTime) {
  for (const r of replies) {
    if (r.deleted) continue;
    const name = r.author?.displayName;
    if (!SELF_DISPLAYNAMES.has(name)) continue;
    if (r.createdTime && gtIso(r.createdTime, commentModifiedTime)) return true;
    if (r.createdTime && r.createdTime === commentModifiedTime) return true;
  }
  return false;
}

async function main() {
  const statePath = argValue('--state');
  const scanOnly = hasFlag('--scan-only');
  if (!statePath) {
    console.error('Missing --state /abs/path/to/state.json');
    process.exit(2);
  }

  const stateAbs = path.resolve(statePath);
  const state = readJson(stateAbs, { lastScanTime: '1970-01-01T00:00:00.000Z', handledCommentIds: {} });
  state.handledCommentIds = state.handledCommentIds || {};

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const docsApi = google.docs({ version: 'v1', auth });

  const files = await listAllDocs(drive);

  const triggers = [];
  for (const f of files) {
    const comments = await listAllComments(drive, f.id);
    for (const c of comments) {
      if (c.deleted) continue;
      if (!shouldTrigger(state, c)) continue;
      triggers.push({
        fileId: f.id,
        fileName: f.name,
        webViewLink: f.webViewLink,
        commentId: c.id,
        comment: {
          author: c.author?.displayName || null,
          modifiedTime: c.modifiedTime,
          createdTime: c.createdTime,
          content: c.content || null,
          resolved: !!c.resolved,
          quoted: c.quotedFileContent?.value || null,
        }
      });
    }
  }

  if (scanOnly) {
    console.log(JSON.stringify({ ok: true, scanOnly: true, statePath: stateAbs, lastScanTime: state.lastScanTime, triggers }, null, 2));
    return;
  }

  const handled = [];
  const actions = [];

  for (const t of triggers) {
    const commentModifiedTime = t.comment.modifiedTime || t.comment.createdTime;
    const replies = await listReplies(drive, t.fileId, t.commentId);

    // Dedupe: if any self-reply exists with createdTime >= comment.modifiedTime, do not reply again.
    const deduped = hasSelfReplyAfter(replies, commentModifiedTime);

    const attempt = {
      ...t,
      deduped,
      edit: null,
      pdf: null,
      qc: null,
      reply: null,
      error: null,
    };

    try {
      // 1) Edit doc in place (best-effort; may be no-op)
      attempt.edit = await applyDocEdit(docsApi, t.fileId, { content: t.comment.content });

      // 2) Export to PDF + 3) QC, retry up to 3
      const stamp = isoNow().replace(/[:.]/g, '-');
      let lastPdf = null;
      let qc = null;
      for (let i = 1; i <= 3; i++) {
        const outPath = path.join(process.cwd(), 'out', 'docs', `${t.fileId}-${stamp}-try${i}.pdf`);
        lastPdf = await exportPdf(drive, t.fileId, outPath);
        qc = qcPdf(lastPdf.outPath);
        if (qc.ok) break;
      }
      attempt.pdf = lastPdf;
      attempt.qc = qc;

      // Reply (idempotency + dedupe enforced here only)
      if (!deduped) {
        // NOTE: actual reply is performed by separate script in the assistant (preferred)
        attempt.reply = {
          shouldReply: true,
          suggestedText: (() => {
            const parts = [];
            if (attempt.edit?.edited) {
              if (attempt.edit?.changed) {
                parts.push(`Applied edit (${attempt.edit.instruction.kind}): “${attempt.edit.instruction.from}” → “${attempt.edit.instruction.to}”.`);
              } else {
                parts.push(`Tried to apply edit (${attempt.edit.instruction.kind}), but couldn’t find the source text to replace. If you paste the exact phrase, I can redo it.`);
              }
            } else {
              parts.push('I didn’t find a clear “replace X with Y” instruction in this comment. If you tell me the exact text to change and the desired replacement, I’ll update the doc.');
            }
            if (attempt.qc?.ok) parts.push('Exported a fresh PDF and it passed a basic integrity check.');
            else parts.push(`PDF export/QC still looks off (${attempt.qc?.reason || 'unknown'}). I can keep trying or we can diagnose formatting.`);
            return parts.join(' ');
          })()
        };
      } else {
        attempt.reply = { shouldReply: false, reason: 'dedupe_asdrubal_reply_exists' };
      }

      // Mark handled no matter what (we processed it this run)
      state.handledCommentIds[String(t.commentId)] = { handledAt: isoNow(), action: 'handled' };
      handled.push(t.commentId);

    } catch (e) {
      attempt.error = String(e?.response?.data ? JSON.stringify(e.response.data) : e);
      state.handledCommentIds[String(t.commentId)] = { handledAt: isoNow(), action: 'error' };
      handled.push(t.commentId);
    }

    actions.push(attempt);
  }

  // End of run: update lastScanTime always.
  const newLastScanTime = isoNow();
  state.lastScanTime = newLastScanTime;
  writeJson(stateAbs, state);

  console.log(JSON.stringify({
    ok: true,
    statePath: stateAbs,
    filesScanned: files.length,
    triggersFound: triggers.length,
    handledCount: handled.length,
    newLastScanTime,
    actions
  }, null, 2));
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
