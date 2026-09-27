#!/usr/bin/env bash
#
# gate.sh — THE one way the suite runs in this project.
#
# Copy to <repo>/scripts/gate.sh, set the two commands for your stack, chmod +x.
# It is the single place where correctness, the machine and the shared host are
# handled at once. Do not hand-roll a test command; do not add a second gate.
#
# EXIT CODES ARE THE VOCABULARY — quote them exactly, never inflate them:
#   0  GREEN    the requested tier ran and passed
#   1  RED      the requested tier ran and FAILED (read the raw log)
#   2  CHEAP    the cheap tier passed and the expensive tier DID NOT run
#   9  REFUSED  another run holds the lock: VOID — not a failure, not evidence
#
# Usage:
#   bash scripts/gate.sh                 # full: cheap + suite (takes the lock)
#   GATE_TESTS=0 bash scripts/gate.sh    # cheap tier only (takes NO lock)
#   GATE_PLAN_ONLY=1 bash scripts/gate.sh
#
# Env (defaults in brackets):
#   GATE_CHEAP_CMD   blocking tier: typecheck / build       [npm run typecheck]
#   GATE_FULL_CMD    expensive tier: the suite              [npm test]
#   GATE_LOG_DIR     where the raw log is written           [<repo>/.gate-logs]
#   GATE_LOCK_DIR    the atomic lock                        [<repo>/.gate-lock]
#   GATE_STALE_MIN   a lock with no live owner older than this is STALE [30]

set -u

# --- where the repo is -------------------------------------------------------
# Derived from the GIT COMMON dir, so this is the SAME path from the main tree and
# from every worktree. That is what makes it ONE lock across writers.
GIT_COMMON="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$GIT_COMMON" ]; then
  REPO_ROOT="$(cd "$GIT_COMMON/.." && pwd)"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))"
fi

CHEAP_CMD="${GATE_CHEAP_CMD:-npm run typecheck}"
FULL_CMD="${GATE_FULL_CMD:-npm test}"
LOG_DIR="${GATE_LOG_DIR:-$REPO_ROOT/.gate-logs}"
LOCK_DIR="${GATE_LOCK_DIR:-$REPO_ROOT/.gate-lock}"
STALE_MIN="${GATE_STALE_MIN:-30}"
TESTS="${GATE_TESTS:-1}"
PLAN_ONLY="${GATE_PLAN_ONLY:-0}"

LOG="$LOG_DIR/gate.log"
LOCKED=0
if [ "$TESTS" = "0" ]; then TIER="cheap"; else TIER="full"; fi

echo "repo:  $REPO_ROOT"
echo "tier:  $TIER (GATE_TESTS=$TESTS)"
echo "cheap: $CHEAP_CMD"
[ "$TESTS" = "0" ] || echo "full:  $FULL_CMD"
echo "log:   $LOG"

if [ "$PLAN_ONLY" = "1" ]; then
  echo "PLAN ONLY — nothing was run."
  exit 2
fi

mkdir -p "$LOG_DIR"
: > "$LOG"

release_lock() { if [ "$LOCKED" = "1" ]; then rm -rf "$LOCK_DIR"; fi; }
trap release_lock EXIT INT TERM

write_owner() {
  printf 'pid=%s\nstarted=%s\ntier=%s\nrepo=%s\n' \
    "$$" "$(date -u +%FT%TZ)" "$TIER" "$REPO_ROOT" > "$LOCK_DIR/owner"
}

# The cheap tier deliberately takes NO lock: it touches nothing shared, so it can
# run alongside an expensive one.
if [ "$TESTS" != "0" ]; then
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    write_owner; LOCKED=1
  else
    OWNER_PID="$(sed -n 's/^pid=//p' "$LOCK_DIR/owner" 2>/dev/null)"
    if [ -n "$OWNER_PID" ] && kill -0 "$OWNER_PID" 2>/dev/null; then
      echo "REFUSED — the gate is already running (pid $OWNER_PID). This run is VOID."
      echo "A refusal is the lock WORKING: not a failure, not evidence. Exit 9."
      exit 9
    fi
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +"$STALE_MIN" 2>/dev/null)" ]; then
      echo "STALE lock (no live owner, older than ${STALE_MIN}m) — removing it and saying so."
      rm -rf "$LOCK_DIR"
      if mkdir "$LOCK_DIR" 2>/dev/null; then write_owner; LOCKED=1; fi
    fi
    if [ "$LOCKED" != "1" ]; then
      echo "REFUSED — lock held (pid ${OWNER_PID:-unknown}), not yet stale. VOID. Exit 9."
      exit 9
    fi
  fi
  echo "lock:  acquired $LOCK_DIR"
fi

run_tier() {
  local label="$1" cmd="$2"
  printf '\n=== %s ===\n$ %s\n' "$label" "$cmd"
  # tee keeps the FULL raw log; PIPESTATUS[0] keeps the COMMAND's own status.
  # Never `| tail`: that destroys the failing evidence AND the exit code, so a
  # `&& commit && push` chain lands unverified work under a message claiming a pass.
  bash -c "$cmd" 2>&1 | tee -a "$LOG"
  return "${PIPESTATUS[0]}"
}

if ! run_tier "cheap tier (blocks a push)" "$CHEAP_CMD"; then
  echo
  echo "RED — the cheap tier failed. Raw log: $LOG"
  exit 1
fi

if [ "$TESTS" = "0" ]; then
  echo
  echo "CHEAP TIER GREEN — the suite did NOT run. Exit 2."
  echo "This is NOT 'the gate passed'. The expensive tier is owed when code changes."
  exit 2
fi

if ! run_tier "full tier (this is what makes it VERIFIED)" "$FULL_CMD"; then
  echo
  echo "RED — the full tier failed. Raw log: $LOG"
  echo "Fix the cause; never re-run until green, and never re-run to get a different answer."
  exit 1
fi

echo
echo "GATE GREEN — both tiers passed. Raw log: $LOG"
exit 0
