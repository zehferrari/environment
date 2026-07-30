#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0

# check_link: verify a live file is a symlink into the checkout and content matches.
# Used for HA files that have already been symlink-swapped.
check_link() {
  local host="$1" live="$2" repo_rel="$3"
  if ! ssh -n -o BatchMode=yes "$host" "test -L '$live'"; then
    echo "FAIL $host:$live is not a symlink" >&2
    fail=1
    return
  fi
  local target
  target="$(ssh -n -o BatchMode=yes "$host" "readlink '$live'")"
  case "$target" in
    */Code/environment/"$repo_rel") ;;
    *) echo "FAIL $host:$live points to $target, expected */Code/environment/$repo_rel" >&2; fail=1 ;;
  esac
  if ! diff -q <(ssh -n -o BatchMode=yes "$host" "cat '$live'") "$ROOT/$repo_rel" >/dev/null; then
    echo "FAIL $host:$live differs from $repo_rel" >&2
    fail=1
  fi
}

# check_content: verify a live file's content matches the repo copy.
# Used for files that haven't been symlink-swapped yet (moonlight nginx configs).
# Once the symlink swap is done on a host, switch to check_link for that file.
check_content() {
  local host="$1" live="$2" repo_rel="$3"
  if ! diff -q <(ssh -n -o BatchMode=yes "$host" "cat '$live'") "$ROOT/$repo_rel" >/dev/null; then
    echo "FAIL $host:$live content differs from $repo_rel" >&2
    fail=1
  else
    echo "OK $host:$live content matches $repo_rel"
  fi
}

# Existing Home Assistant mirror links. automations.yaml/scripts.yaml are tracked
# drift captures for now; HA UI writer symlink-safety still needs a live UI test.
# Collect the file list into an array first so ssh -n inside the loop doesn't
# consume the find stream from stdin (which caused only 1 iteration to run).
mapfile -d '' ha_files < <(find "$ROOT/ha" -type f -print0)
for file in "${ha_files[@]}"; do
  rel="${file#"$ROOT/"}"
  base="${rel#ha/}"
  case "$base" in automations.yaml|scripts.yaml|README.md) continue ;; esac
  ssh -n -o BatchMode=yes ha "test -e '/config/$base'" >/dev/null 2>&1 || continue
  check_link ha "/config/$base" "$rel"
done

# Moonlight nginx files introduced by ENV-112.
# Content-diff only until the symlink swap is performed on moonlight.
for rel in \
  moonlight/nginx/sites-available/zeh \
  moonlight/nginx/sites-available/modules/restrictionsRules \
  moonlight/nginx/conf.d/block-scanners.conf
do
  live="/etc/nginx/${rel#moonlight/nginx/}"
  check_content moonlight "$live" "$rel"
done

exit "$fail"
