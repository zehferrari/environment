#!/usr/bin/env bash
# Move PM's SQLite DB out of the app/worktree, create a timestamped backup,
# compact it with VACUUM INTO, enable WAL, and update /etc/default/pm.
# Run as root on the PM host while pm.service/pm-consumer.service are stopped.
set -euo pipefail

ENV_FILE="${PM_ENV_FILE:-/etc/default/pm}"
TARGET_DIR="${PM_SQLITE_DIR:-/srv/Data/pm}"
TARGET_DB="${PM_SQLITE_DB:-$TARGET_DIR/pm.db}"
APP_USER="${PM_APP_USER:-karen}"
APP_GROUP="${PM_APP_GROUP:-karen}"
SERVICES=(pm.service pm-consumer.service)

say(){ printf '\n==> %s\n' "$*"; }
die(){ printf 'move-sqlite-db: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is required"
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"
id "$APP_USER" >/dev/null 2>&1 || die "app user not found: $APP_USER"
getent group "$APP_GROUP" >/dev/null 2>&1 || die "app group not found: $APP_GROUP"

raw_url="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true)"
[[ -n "$raw_url" ]] || die "DATABASE_URL missing from $ENV_FILE"
[[ "$raw_url" == file:* ]] || die "only SQLite file: DATABASE_URL is supported (got $raw_url)"

url_no_query="${raw_url%%\?*}"
if [[ "$url_no_query" == file://* ]]; then
  src_db="${url_no_query#file://}"
else
  src_db="${url_no_query#file:}"
fi
[[ "$src_db" = /* ]] || die "current DATABASE_URL must be absolute before controlled move (got $raw_url)"
[[ -f "$src_db" ]] || die "source DB not found: $src_db"

mkdir -p "$TARGET_DIR"
chown "$APP_USER:$APP_GROUP" "$TARGET_DIR"
chmod 0750 "$TARGET_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$TARGET_DIR/pm.$stamp.pre-move.db"
tmp="$TARGET_DB.tmp.$stamp"

say "Stopping PM services"
for svc in "${SERVICES[@]}"; do
  systemctl is-active --quiet "$svc" && systemctl stop "$svc" || true
done

cleanup(){ rm -f "$tmp"; }
trap cleanup EXIT

say "Checkpointing source WAL and verifying integrity"
sqlite3 "$src_db" 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA quick_check;'

say "Backing up source DB → $backup"
install -o "$APP_USER" -g "$APP_GROUP" -m 0640 "$src_db" "$backup"
for suffix in -wal -shm; do
  [[ -f "$src_db$suffix" ]] && install -o "$APP_USER" -g "$APP_GROUP" -m 0640 "$src_db$suffix" "$backup$suffix"
done

say "VACUUM INTO compact target → $TARGET_DB"
rm -f "$tmp"
sqlite3 "$src_db" "VACUUM INTO '$tmp';"
chown "$APP_USER:$APP_GROUP" "$tmp"
chmod 0640 "$tmp"
mv -f "$tmp" "$TARGET_DB"

say "Enable WAL and normal locking on target"
sqlite3 "$TARGET_DB" 'PRAGMA journal_mode=WAL; PRAGMA locking_mode=NORMAL; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA quick_check;'
chown "$APP_USER:$APP_GROUP" "$TARGET_DB" "$TARGET_DB-wal" "$TARGET_DB-shm" 2>/dev/null || true
chmod 0640 "$TARGET_DB" "$TARGET_DB-wal" "$TARGET_DB-shm" 2>/dev/null || true

say "Update $ENV_FILE DATABASE_URL"
new_url="file://$TARGET_DB"
cp -a "$ENV_FILE" "$ENV_FILE.bak.$stamp"
python3 - "$ENV_FILE" "$new_url" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
new = f'DATABASE_URL={sys.argv[2]}'
lines = path.read_text().splitlines()
out = []
seen = False
for line in lines:
    if line.startswith('DATABASE_URL='):
        out.append(new)
        seen = True
    else:
        out.append(line)
if not seen:
    out.append(new)
path.write_text('\n'.join(out) + '\n')
PY

say "Freelist/page metrics after vacuum"
sqlite3 "$TARGET_DB" 'SELECT "page_count", pragma_page_count(); SELECT "freelist_count", pragma_freelist_count(); SELECT "freelist_ratio", printf("%.4f", CAST(pragma_freelist_count() AS REAL) / NULLIF(pragma_page_count(), 0)); SELECT "journal_mode", * FROM pragma_journal_mode; SELECT "locking_mode", * FROM pragma_locking_mode;'

say "Reloading systemd and starting PM services"
systemctl daemon-reload
for svc in "${SERVICES[@]}"; do
  systemctl start "$svc" 2>/dev/null || true
done

say "Done. backup=$backup target=$TARGET_DB env_backup=$ENV_FILE.bak.$stamp"
