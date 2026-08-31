#!/usr/bin/env bash
#
# Shared commit-and-push for the scheduled workflows.
#
# Every scheduled job used to end with a bare `git push`, which loses a race
# it can't win: actions/checkout pins a SHA at job start, the job then runs
# for minutes, and main moves during that window (the injury sync alone
# pushes several times an hour). By push time the commit's parent is no
# longer the tip, GitHub rejects it as non-fast-forward, and the run goes red
# with its work thrown away - even though nothing was actually wrong.
#
# This rebases onto whatever landed and retries. Each workflow has its own
# concurrency group, so two runs of the same job never overlap and the replay
# is against some *other* job's commit, touching different files. A real
# textual conflict therefore shouldn't happen; if one does, this aborts and
# fails rather than force-pushing over someone else's work. The next
# scheduled run regenerates the same data anyway, so a failed run costs a
# cycle, not data.
#
# Usage:
#   scripts/commit-and-push.sh "<commit message>" <path> [path...]
#
# Optional env:
#   PUSH_ATTEMPTS  - push/rebase attempts before giving up (default 5)
#   GIT_BOT_NAME   - committer name (default blitz-odds-bot)
#   GIT_BOT_EMAIL  - committer email (default actions@users.noreply.github.com)
#   PUSH_BRANCH    - branch to push to (default main)

set -euo pipefail

MESSAGE=${1:-}
shift || true

if [ -z "$MESSAGE" ] || [ "$#" -eq 0 ]; then
  echo "usage: scripts/commit-and-push.sh \"<commit message>\" <path> [path...]" >&2
  exit 2
fi

ATTEMPTS=${PUSH_ATTEMPTS:-5}
BRANCH=${PUSH_BRANCH:-main}

# --porcelain rather than `git diff --quiet`, which only sees changes to
# already-tracked files. static-pages-refresh generates brand-new game and
# team pages, and under the old check a run that added pages without
# modifying any existing one reported "No changes to commit" and dropped
# them.
if [ -z "$(git status --porcelain -- "$@")" ]; then
  echo "No changes to commit."
  exit 0
fi

git config user.name "${GIT_BOT_NAME:-blitz-odds-bot}"
git config user.email "${GIT_BOT_EMAIL:-actions@users.noreply.github.com}"
git add -A -- "$@"
git commit -m "$MESSAGE"

# actions/checkout defaults to a depth-1 clone, which has no common ancestor
# to rebase against once origin moves. Deepen before the first rebase, not on
# every run - an unshallow costs a full history fetch and the overwhelming
# majority of runs push cleanly on attempt 1 and never get here.
deepen_if_shallow() {
  if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
    echo "Shallow clone - fetching full history so the rebase has a merge base..."
    git fetch --unshallow origin "$BRANCH" 2>/dev/null \
      || git fetch --deepen=100 origin "$BRANCH" 2>/dev/null \
      || echo "Warning: could not deepen the clone; the rebase may fail."
  fi
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  if git push origin "HEAD:$BRANCH"; then
    echo "Pushed on attempt $attempt."
    exit 0
  fi

  echo "Push rejected (attempt $attempt/$ATTEMPTS) - rebasing onto origin/$BRANCH..."
  deepen_if_shallow
  git fetch origin "$BRANCH"

  if ! git rebase "origin/$BRANCH"; then
    git rebase --abort || true
    echo "Rebase hit a conflict against origin/$BRANCH. Refusing to force-push over another job's commit - this run's changes are left uncommitted and the next scheduled run will redo them." >&2
    exit 1
  fi

  sleep $(( attempt * 3 ))
done

echo "Could not push after $ATTEMPTS attempts - giving up." >&2
exit 1
