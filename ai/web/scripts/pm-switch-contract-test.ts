import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const switcher = read("deploy/pm-switch.sh");
const runner = read("deploy/pm-switch-runner");
const actions = read("lib/deploy/actions.ts");
const rebuild = read("deploy/rebuild-and-restart.sh");
const managedUpdate = read("deploy/update-managed-host.sh");
const installer = read("deploy/install-pm-switch.sh");

assert.match(switcher, /WORKTREE_NAME="\$\(basename "\$WT_ROOT"\)"/,
  "database identity must be based on stable worktree name");
assert.doesNotMatch(switcher, /wt-\$BRANCH_SLUG\.db/,
  "checked-out branch must never select the database implicitly");
assert.match(switcher, /--database=worktree\|main/,
  "CLI must expose explicit database intent");
assert.doesNotMatch(switcher, /--database=.*canonical|path:<absolute>/,
  "the canonical seed and arbitrary paths must not be live switch targets");
assert.match(switcher, /database intent is ambiguous:[^\n]+worktree 'main'/,
  "a temporary main-worktree branch mismatch must fail closed");
assert.match(switcher, /resolved database escapes the configured PM DB root/,
  "symlink-resolved database paths must remain contained");

const quickCheck = switcher.indexOf("PRAGMA quick_check;");
const stopLive = switcher.indexOf("--stop-live", quickCheck);
const checkpoint = switcher.indexOf("PRAGMA wal_checkpoint(TRUNCATE);", stopLive);
const migrate = switcher.indexOf("prisma migrate deploy", checkpoint);
const receipt = switcher.indexOf('RECEIPT_FILE="$RECEIPT_DIR/');
const receiptPreflight = switcher.indexOf("deployment receipt directory is missing or not writable");
const consumerVerified = switcher.indexOf('[[ "$consumer_active" == "active" ]]');
assert(quickCheck >= 0 && stopLive > quickCheck,
  "database integrity preflight must finish before live services stop");
assert(stopLive >= 0 && checkpoint > stopLive && migrate > checkpoint,
  "the stopped database WAL must checkpoint before Prisma requests its schema lock");
assert(consumerVerified >= 0 && receipt > consumerVerified,
  "deployment receipt must be published only after both services verify");
assert.match(switcher, /deployment receipt directory is missing or not writable/,
  "receipt permissions must fail during preflight, before services stop");
assert(receiptPreflight >= 0 && receiptPreflight < stopLive,
  "receipt permission validation must precede the first service stop");
assert.match(installer, /install -d -o "\$MON" -g "\$CODE_GROUP" -m 2770 "\$RECEIPT_DIR"/,
  "installer must provision receipts for both monitor and code-agent deployers");
assert.match(installer, /PM_DEPLOY_RECEIPT_DIR=%s/,
  "the root-owned deployment contract must publish the receipt path");
assert.match(switcher, /ORDER BY migration_name DESC LIMIT 1/,
  "receipt schema level must not depend on mixed SQLite timestamp storage classes");

assert.match(actions, /databaseSelection: "worktree"/,
  "browser requests must state their database intent");
assert.match(runner, /command\.append\(f"--database=\{database_selection\}"\)/,
  "the PM runner must preserve the browser's explicit database selection");
assert.match(runner, /database_selection not in \{"", "worktree", "main"\}/,
  "browser requests must not select arbitrary database paths or the canonical seed");
assert.match(rebuild, /exec "\$PM_SWITCH" --database=worktree "\$WT_ROOT"/,
  "legacy rebuild delegation must state its stable worktree database intent");
assert.match(managedUpdate, /pm-switch --database=worktree "\$WORKTREE"/,
  "managed host releases must state their stable worktree database intent");

console.log("pm-switch deployment contract tests passed");
