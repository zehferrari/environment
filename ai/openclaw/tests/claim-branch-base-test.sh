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

# ── Epic mode (P6 local-only child branches) ─────────────────────────────
CODE_ROOT="$tmp/code"
mkdir -p "$CODE_ROOT"
git clone --quiet "$remote" "$CODE_ROOT/proj"
git -C "$CODE_ROOT/proj" config user.name "PM Test"
git -C "$CODE_ROOT/proj" config user.email "pm-test@example.invalid"

# 1. Epic branch absent on origin: created locally from origin/main; the task
#    branch is based on it and NEITHER branch is pushed.
wt=$(cmd_claim proj ph-1-task epic-a)
[ -d "$wt" ] || { printf 'epic-mode claim must create a worktree\n' >&2; exit 1; }
[ -f "$wt/.git" ] || { printf 'claimed task directory must be a linked worktree (.git file)\n' >&2; exit 1; }
validate_implementer_worktree "$CODE_ROOT/proj" "$wt" ph-1-task
[ "$(git -C "$CODE_ROOT/proj" config --get branch.ph-1-task.pmEpicBranch)" = "epic-a" ] || {
  printf 'epic mode must register shared local-only branch metadata\n' >&2
  exit 1
}
git -C "$CODE_ROOT/proj" rev-parse --verify --quiet refs/heads/epic-a >/dev/null || {
  printf 'epic mode must create the missing Epic branch locally\n' >&2
  exit 1
}
[ "$(git -C "$CODE_ROOT/proj" rev-parse refs/heads/ph-1-task)" = "$(git -C "$CODE_ROOT/proj" rev-parse refs/remotes/origin/main)" ] || {
  printf 'a fresh Epic-child branch must start at the fetched origin/main tip (via the local Epic branch)\n' >&2
  exit 1
}
[ -z "$(git -C "$CODE_ROOT/proj" ls-remote --heads origin ph-1-task)" ] || {
  printf 'epic mode must NOT push the task branch\n' >&2
  exit 1
}
[ -z "$(git -C "$CODE_ROOT/proj" ls-remote --heads origin epic-a)" ] || {
  printf 'epic mode must NOT push the Epic branch\n' >&2
  exit 1
}

# 2. Epic branch present on origin: the child is based on its freshly fetched
#    tip, still without pushing anything.
git -C "$publisher" fetch --quiet origin
git -C "$publisher" checkout --quiet -b epic-b origin/main
printf 'epic b\n' > "$publisher/epic-b.txt"
git -C "$publisher" add epic-b.txt
git -C "$publisher" commit --quiet -m epic-b
git -C "$publisher" push --quiet -u origin epic-b
wt2=$(cmd_claim proj ph-2-task epic-b)
[ "$(git -C "$CODE_ROOT/proj" rev-parse refs/heads/ph-2-task)" = "$(git -C "$CODE_ROOT/proj" rev-parse refs/remotes/origin/epic-b)" ] || {
  printf 'an Epic-child branch must start at the freshly fetched origin Epic tip\n' >&2
  exit 1
}
[ -z "$(git -C "$CODE_ROOT/proj" ls-remote --heads origin ph-2-task)" ] || {
  printf 'epic mode must NOT push the task branch (existing origin Epic case)\n' >&2
  exit 1
}

# 3. Re-claim is idempotent and still does not push.
wt_again=$(cmd_claim proj ph-1-task epic-a)
[ "$wt_again" = "$wt" ] || { printf 're-claim must return the existing worktree\n' >&2; exit 1; }
[ -z "$(git -C "$CODE_ROOT/proj" ls-remote --heads origin ph-1-task)" ] || {
  printf 're-claim must NOT push the task branch\n' >&2
  exit 1
}

# 4. The host pre-push hook blocks both normal and explicit HEAD publication
#    of a branch registered by --epic, while leaving deletion available for
#    recovery of a leaked legacy ref.
git -C "$CODE_ROOT/proj" config core.hooksPath "$HERE/../git-hooks"
if git -C "$wt" push origin ph-1-task >/dev/null 2>&1; then
  printf 'pre-push must reject publication of an Epic-child task branch\n' >&2
  exit 1
fi
if git -C "$wt" push origin HEAD:ph-1-task >/dev/null 2>&1; then
  printf 'pre-push must reject explicit HEAD publication of an Epic-child task branch\n' >&2
  exit 1
fi
[ -z "$(git -C "$CODE_ROOT/proj" ls-remote --heads origin ph-1-task)" ] || {
  printf 'blocked pre-push attempts must leave origin without the task branch\n' >&2
  exit 1
}

# 5. An ordinary pre-existing directory can never be mistaken for a claimed
#    task worktree. Preserve it and fail with no branch/ref mutation.
mkdir -p "$CODE_ROOT/proj.worktrees/not-a-worktree"
printf 'preserve me\n' > "$CODE_ROOT/proj.worktrees/not-a-worktree/untracked.txt"
if ( cmd_claim proj not-a-worktree epic-a ) >/dev/null 2>&1; then
  printf 'claim must reject an ordinary directory at the deterministic worktree path\n' >&2
  exit 1
fi
[ "$(cat "$CODE_ROOT/proj.worktrees/not-a-worktree/untracked.txt")" = "preserve me" ] || {
  printf 'claim rejection must preserve the ordinary directory contents\n' >&2
  exit 1
}
git -C "$CODE_ROOT/proj" rev-parse --verify --quiet refs/heads/not-a-worktree >/dev/null && {
  printf 'rejected ordinary directory must not create a branch\n' >&2
  exit 1
}

# 6. Review access reuses the existing attached worktree. Status gates make
#    assignee/reviewer access sequential, so no detached __review tree exists.
printf 'local work\n' > "$wt/local-work.txt"
git -C "$wt" add local-work.txt
git -C "$wt" -c user.name="PM Test" -c user.email="pm-test@example.invalid" commit --quiet -m "ph-1 local work"
rwt=$(cmd_claim_review proj ph-1-task)
[ "$rwt" = "$wt" ] || {
  printf 'review access must return the existing attached task worktree\n' >&2
  exit 1
}
[ "$(git -C "$rwt" symbolic-ref --quiet --short HEAD)" = "ph-1-task" ] || {
  printf 'review access must remain attached to the task branch\n' >&2
  exit 1
}
[ ! -e "$CODE_ROOT/proj.worktrees/ph-1-task__review" ] || {
  printf 'review access must not create a detached __review directory\n' >&2
  exit 1
}

# 7. A PM-owned standalone claim stays local until the PM submission runner
#    pushes it. Interactive pushes are blocked by the shared hook.
pm_wt=$(cmd_claim proj pm-standalone "" true)
[ -d "$pm_wt" ] || { printf 'PM claim must create a worktree\n' >&2; exit 1; }
[ -z "$(git -C "$CODE_ROOT/proj" ls-remote --heads origin pm-standalone)" ] || {
  printf 'PM claim must not publish a new standalone branch\n' >&2
  exit 1
}
[ "$(git -C "$CODE_ROOT/proj" config --bool --get branch.pm-standalone.pmManaged)" = true ] || {
  printf 'PM claim must mark the branch as PM-managed\n' >&2
  exit 1
}
if git -C "$pm_wt" push origin pm-standalone >/dev/null 2>&1; then
  printf 'pre-push must reject agent publication of a PM-managed branch\n' >&2
  exit 1
fi
git -C "$pm_wt" push --no-verify origin pm-standalone >/dev/null 2>&1 || {
  printf 'trusted PM publication boundary must be able to bypass the local guard\n' >&2
  exit 1
}

printf 'claim-branch-base-test passed\n'
