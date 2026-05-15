#!/usr/bin/env node
/*
Idempotent runner for the “ALL docs comments monitor”.

Contract:
- Reads/updates state via the underlying scripts.
- If ABSOLUTE TRIGGER RULES find no candidates, produces NO stdout.
- If triggered, runs the full workflow and prints the JSON summary from docs-comments-cron-all.js.

Usage:
  node docs-comments-monitor-run.js /abs/path/to/docs-comment-state.json
*/

const path = require('path');
const { spawnSync } = require('child_process');

function runNode(script, args) {
  const p = path.join(__dirname, script);
  const res = spawnSync('node', [p, ...args], { encoding: 'utf8' });
  return {
    code: res.status ?? 0,
    stdout: res.stdout || '',
    stderr: res.stderr || ''
  };
}

function die(msg, code = 1) {
  process.stderr.write(String(msg) + '\n');
  process.exit(code);
}

async function main() {
  const statePathArg = process.argv[2];
  if (!statePathArg) die('Usage: node docs-comments-monitor-run.js <statePath>', 2);
  const statePath = path.resolve(statePathArg);

  // Pre-check (also updates lastScanTime when no candidates)
  const pre = runNode('docs-comments-cron-all-wrapper.js', [statePath]);
  if (pre.code !== 0) {
    die(pre.stderr || 'precheck_failed', pre.code || 1);
  }

  const triggered = (pre.stdout || '').trim() === 'TRIGGERED';
  if (!triggered) {
    // IMPORTANT: no stdout when not triggered.
    return;
  }

  // Run full workflow; emit JSON summary.
  const run = runNode('docs-comments-cron-all.js', [statePath]);
  if (run.code !== 0) {
    die(run.stderr || 'run_failed', run.code || 1);
  }

  process.stdout.write(run.stdout);
}

main().catch((e) => die(String(e?.stack || e), 1));
