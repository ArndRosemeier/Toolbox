#!/usr/bin/env bash
#
# board.sh — reconcile the board against reality.
#
# Copy to <repo>/scripts/board.sh, chmod +x.
#
# The board is PROSE ABOUT STATE: it is CHECKED, never believed. Run this before
# dispatching anything, and again after every landing.
#
# Prints "BOARD RECONCILED" (exit 0) or "BOARD STALE" (exit 1), and says LOUDLY when
# a check cannot look — silence is never a pass.
#
# Env (defaults in brackets):
#   BOARD_FILE           [docs/BOARD.md]
#   BOARD_REMOTE         [origin]
#   BOARD_BRANCH         [main]
#   BOARD_SUITE_PATTERN  pgrep pattern for suite processes [vites[t]|jest|pytest]
#   GATE_LOCK_DIR        [<repo>/.gate-lock]

set -u

BOARD_FILE="${BOARD_FILE:-docs/BOARD.md}"
REMOTE="${BOARD_REMOTE:-origin}"
BRANCH="${BOARD_BRANCH:-main}"
SUITE_PATTERN="${BOARD_SUITE_PATTERN:-vites[t]|jest|pytest}"

GIT_COMMON="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$GIT_COMMON" ]; then
  REPO_ROOT="$(cd "$GIT_COMMON/.." && pwd)"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
LOCK_DIR="${GATE_LOCK_DIR:-$REPO_ROOT/.gate-lock}"

STALE=0
note()  { printf '  %s\n' "$1"; }
stale() { printf '  STALE: %s\n' "$1"; STALE=1; }

echo "=== board reconciler ==="
echo "board:  $BOARD_FILE"
echo "remote: $REMOTE/$BRANCH"

# --- can we look at all? -----------------------------------------------------
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "CANNOT LOOK: not inside a git repository."; exit 1
fi
if [ ! -f "$BOARD_FILE" ]; then
  echo "CANNOT LOOK: $BOARD_FILE does not exist."; exit 1
fi

git fetch -q "$REMOTE" "$BRANCH" 2>/dev/null \
  || echo "  NOTE: fetch failed — comparing against the last known remote state."
REMOTE_SHA="$(git rev-parse "$REMOTE/$BRANCH" 2>/dev/null || true)"
if [ -z "$REMOTE_SHA" ]; then
  echo "CANNOT LOOK: $REMOTE/$BRANCH does not resolve."; exit 1
fi
echo "remote: $REMOTE/$BRANCH = $REMOTE_SHA"

# --- local vs remote: reconcile against the REMOTE, never a stale local ------
LOCAL_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  note "local HEAD == $REMOTE/$BRANCH"
else
  stale "local HEAD ($LOCAL_SHA) != $REMOTE/$BRANCH ($REMOTE_SHA) — reconcile against the REMOTE"
fi

# --- every sha claimed LANDED must be an ancestor of the remote --------------
echo "=== landed shas ==="
LANDED="$(sed -n 's/^LANDED.*sha=\([0-9a-f]\{7,40\}\).*/\1/p' "$BOARD_FILE" | sort -u)"
if [ -z "$LANDED" ]; then
  note "none claimed"
else
  for sha in $LANDED; do
    if git merge-base --is-ancestor "$sha" "$REMOTE_SHA" 2>/dev/null; then
      note "$sha is on $REMOTE/$BRANCH"
    else
      stale "$sha claimed LANDED but is not an ancestor of $REMOTE/$BRANCH"
    fi
  done
fi

# --- the reconciled marker ---------------------------------------------------
echo "=== reconciled marker ==="
RECON="$(sed -n 's/^reconciled: \([0-9a-f]\{7,40\}\).*/\1/p' "$BOARD_FILE" | head -1)"
if [ -z "$RECON" ]; then
  stale "no 'reconciled: <sha>' marker"
elif git merge-base --is-ancestor "$RECON" "$REMOTE_SHA" 2>/dev/null; then
  note "$RECON is an ancestor of the remote"
else
  stale "marker $RECON is NOT an ancestor of $REMOTE/$BRANCH"
fi

# --- branches claimed retired must be gone -----------------------------------
echo "=== retired branches ==="
RETIRED="$(sed -n 's/.*retired=[^|]*branch \([^ |]*\).*/\1/p' "$BOARD_FILE" | sort -u)"
if [ -z "$RETIRED" ]; then
  note "none claimed"
else
  for br in $RETIRED; do
    if git show-ref --verify --quiet "refs/heads/$br"; then
      stale "branch '$br' claimed retired but still exists"
    else
      note "$br is gone"
    fi
  done
fi

# --- host --------------------------------------------------------------------
echo "=== host ==="
note "load:   $(uptime | sed 's/.*load average: //')"
note "suites: $(pgrep -af "$SUITE_PATTERN" 2>/dev/null | wc -l) matching process(es)"
if [ -d "$LOCK_DIR" ]; then
  note "lock:   HELD — $(tr '\n' ' ' < "$LOCK_DIR/owner" 2>/dev/null)"
else
  note "lock:   free"
fi

echo
if [ "$STALE" = "0" ]; then
  echo "BOARD RECONCILED"
  exit 0
fi
echo "BOARD STALE — fix the record before dispatching"
exit 1
