import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

// Exercise the real pre-migration stop section with a deployer who cannot
// inspect the active database. Root must make that decision, even across trees.
const stopSection = switcher.slice(
  switcher.indexOf('branch_db_real="$(readlink -f "$BRANCH_DB")"'),
  switcher.indexOf("# systemd can report both writers stopped"),
);
for (const helperStatus of [0, 17]) {
  const result = spawnSync("bash", ["-c", `
    set -euo pipefail
    BRANCH_DB=/tmp/pm-test/wt-main.db
    BRANCH_DB_URL=file:$BRANCH_DB
    db_root_real=/tmp/pm-test
    WT_ROOT=/tmp/worktrees/main
    STANDALONE=$WT_ROOT/ai/web/.next/standalone
    APPLY=/test/pm-apply-worktree
    readlink() { printf '%s\\n' "$2"; }
    log() { :; }
    die() { exit 1; }
    served_worktree() { printf /tmp/worktrees/feature; }
    active_database_url() { return 1; }
    sudo() { printf '%s\\n' "$*"; return ${helperStatus}; }
    ${stopSection}
    printf 'MIGRATION_REACHED\\n'
  `], { encoding: "utf8" });
  assert.equal(result.status, helperStatus, result.stderr);
  assert.match(result.stdout, /-n \/test\/pm-apply-worktree --stop-live .* file:\/tmp\/pm-test\/wt-main.db/,
    "the privileged live database check must run even when the env is unreadable");
  assert.equal(result.stdout.includes("MIGRATION_REACHED"), helperStatus === 0,
    "a failed live database check must prevent migration");
}
assert.match(read("deploy/systemd/pm-switch-runner.service"), /SupplementaryGroups=__PM_MONITOR_GROUP__/,
  "the runner must retain its private group when using the shared primary group");
assert.match(installer, /s#__PM_MONITOR_GROUP__#\$MON_GROUP#g/,
  "the installer must render the monitor's actual private group");

console.log("pm-switch deployment contract tests passed");
