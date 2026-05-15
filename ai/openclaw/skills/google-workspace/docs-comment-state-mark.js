const fs = require('fs');
const path = require('path');

// Mark handled comment IDs in docs-comment-state.json (or any compatible state file).
// Usage:
//   node docs-comment-state-mark.js <statePath> <commentId> [commentId...]

function usage() {
  console.error('Usage: node docs-comment-state-mark.js <statePath> <commentId> [commentId...]');
  process.exit(1);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function main() {
  const [statePath, ...ids] = process.argv.slice(2);
  if (!statePath || ids.length === 0) usage();

  const abs = path.resolve(statePath);
  const state = readJson(abs, { handledCommentIds: {} });
  state.handledCommentIds = state.handledCommentIds || {};

  const now = new Date().toISOString();
  for (const id of ids) {
    if (!id) continue;
    state.handledCommentIds[String(id)] = { handledAt: now };
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ ok: true, statePath: abs, marked: ids.length }, null, 2));
}

main();
