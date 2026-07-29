#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0

check_link() {
  local host="$1" live="$2" repo_rel="$3"
  if ! ssh -o BatchMode=yes "$host" "test -L '$live'"; then
    echo "FAIL $host:$live is not a symlink" >&2
    fail=1
    return
  fi
  local target
  target="$(ssh -o BatchMode=yes "$host" "readlink '$live'")"
  case "$target" in
    */Code/environment/"$repo_rel") ;;
    *) echo "FAIL $host:$live points to $target, expected */Code/environment/$repo_rel" >&2; fail=1 ;;
  esac
  if ! diff -q <(ssh -o BatchMode=yes "$host" "cat '$live'") "$ROOT/$repo_rel" >/dev/null; then
    echo "FAIL $host:$live differs from $repo_rel" >&2
    fail=1
  fi
}

# Existing Home Assistant mirror links. automations.yaml/scripts.yaml are tracked
# drift captures for now; HA UI writer symlink-safety still needs a live UI test.
while IFS= read -r -d '' file; do
  rel="${file#"$ROOT/"}"
  base="${rel#ha/}"
  case "$base" in automations.yaml|scripts.yaml|README.md) continue ;; esac
  ssh -o BatchMode=yes ha "test -e '/config/$base'" >/dev/null 2>&1 || continue
  check_link ha "/config/$base" "$rel"
done < <(find "$ROOT/ha" -type f -print0)

# Moonlight nginx files introduced by ENV-112.
for rel in \
  moonlight/nginx/sites-available/zeh \
  moonlight/nginx/sites-available/modules/restrictionsRules \
  moonlight/nginx/conf.d/block-scanners.conf
do
  live="/etc/nginx/${rel#moonlight/nginx/}"
  check_link moonlight "$live" "$rel"
done

exit "$fail"
