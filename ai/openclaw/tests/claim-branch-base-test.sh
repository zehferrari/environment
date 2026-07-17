#!/bin/bash
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../bin/claim-branch
source "$HERE/../bin/claim-branch"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

remote="$tmp/remote.git"
repo="$tmp/repo"
git init --bare --quiet "$remote"
git init --quiet -b master "$repo"
git -C "$repo" config user.name "PM Test"
git -C "$repo" config user.email "pm-test@example.invalid"
printf 'base\n' > "$repo/base.txt"
git -C "$repo" add base.txt
git -C "$repo" commit --quiet -m base
git -C "$repo" remote add origin "$remote"
git -C "$repo" push --quiet -u origin master

resolved=$(resolve_base_branch "$repo")
[ "$resolved" = master ] || {
  printf 'expected master fallback, got %s\n' "$resolved" >&2
  exit 1
}

publisher="$tmp/publisher"
git clone --quiet "$remote" "$publisher"
git -C "$publisher" config user.name "PM Test"
git -C "$publisher" config user.email "pm-test@example.invalid"
git -C "$publisher" checkout --quiet -b remote-only origin/master
printf 'remote only\n' > "$publisher/remote-only.txt"
git -C "$publisher" add remote-only.txt
git -C "$publisher" commit --quiet -m remote-only
git -C "$publisher" push --quiet -u origin remote-only
if git -C "$repo" rev-parse --verify --quiet refs/remotes/origin/remote-only >/dev/null; then
  printf 'test setup unexpectedly cached remote-only in the consumer clone\n' >&2
  exit 1
fi
fetch_remote_branch "$repo" remote-only
git -C "$repo" rev-parse --verify --quiet refs/remotes/origin/remote-only >/dev/null || {
  printf 'claim-branch must fetch an uncached existing remote feature branch\n' >&2
  exit 1
}

git -C "$repo" checkout --quiet -b main
printf 'main\n' > "$repo/main.txt"
git -C "$repo" add main.txt
git -C "$repo" commit --quiet -m main
git -C "$repo" push --quiet -u origin main

resolved=$(resolve_base_branch "$repo")
[ "$resolved" = main ] || {
  printf 'expected main preference, got %s\n' "$resolved" >&2
  exit 1
}

if claim_source=$(declare -f main) && printf '%s\n' "$claim_source" | grep -q -- '--from'; then
  :
else
  printf 'claim-branch must continue rejecting caller-controlled --from bases\n' >&2
  exit 1
fi

printf 'claim-branch-base-test passed\n'
