# The gate — one command, two tiers

**One script runs the suite. Nobody hand-rolls a test command.** The gate is the
single place where correctness, the machine and the shared host are handled at once.
The implementation is [`../scaffold/scripts/gate.sh`](../scaffold/scripts/gate.sh);
this doc is the contract it implements.

## Two tiers, because they answer two different questions

| | Cheap tier | Full tier |
| --- | --- | --- |
| Command | `GATE_TESTS=0 bash scripts/gate.sh` | `bash scripts/gate.sh` |
| Runs | typecheck / build — what can break a deploy | lint + typecheck + the suite |
| Question | *does it still build?* | *did behaviour move?* |
| Cost | seconds | minutes |
| Blocks | **the push** | nothing — it follows the push |
| Takes the lock | no | yes |
| Exit | `2` | `0` green / `1` red |

**The tiers must never be confused.** `2` means the cheap tier passed and the
expensive tier **did not run**. It is never "the gate passed", and a change is not
VERIFIED until the full tier is green on it.

**Why the cheap tier is the blocking one.** It runs exactly what can break a deploy.
Where a deploy is `tsc -b && vite build`, a type error is what silently ships the
previous bundle — so the blocking tier runs that, and the suite (which is minutes of
a shared machine) follows the push instead. A build-config diff is the exception:
it can pass typecheck and still break the build, so the cheap tier must run the
build for it too.

**Why the full tier may follow the push.** A bounded, written-down trade: the remote
may carry a compile-clean commit for the few minutes the full tier runs. It is
acceptable **only** while the project has one consumer, and it reverts to
gate-then-push the moment a second user or a second consumer of the main branch
exists. Two rules keep it from decaying: the full run is started **in the same
session that pushed** (an unowned background gate is how a red result gets lost),
and a red is fixed forward **immediately**, never stacked behind another unverified
commit.

**Who runs what.** The **dispatcher** runs the full tier, once per landing, on the
integrated tree. A **writer** carries the cheap tier, which is what blocks its push.
The one exception is a slice that touches the **verification machinery itself** (the
gate script, build config, the test setup): only running the suite *through* those
can verify them, so that writer runs the full tier in-turn, and the dispatcher's
integrated run still follows.

## Exit codes are the vocabulary

Quote them exactly; never inflate them.

| Code | Meaning |
| --- | --- |
| `0` | GREEN — the requested tier ran and passed |
| `1` | RED — the requested tier ran and FAILED (read the raw log) |
| `2` | CHEAP — the cheap tier passed, the expensive tier did **not** run |
| `9` | REFUSED — another run holds the lock. **VOID**: not a failure, not evidence |

A "busy" code is the lock **working**. Do not reap another actor's processes to
clear it; wait and retry.

## The rules around it

1. **One expensive check at a time, enforced by an atomic lock — not a glance.** Two
   observers can look in the same instant and both see "free", so the second starter
   must be refused *by the lock itself*. The lock is an atomic `mkdir` derived from
   the **git common dir**, so it is the same path from the main tree and from every
   worktree. It lives in the repo, never `/tmp`, whose persistence depends on a
   sandbox mode that is not yours to rely on.
2. **A cheap check that reads nothing shared does not take the lock**, so it can run
   alongside an expensive one.
3. **A killed run's result is VOID**, never evidence: re-run it under the lock.
4. **A red gate is information, not an obstacle.** Fix the cause; never re-run until
   green, and never re-run to get a different answer.
5. **An injection holds the tree only while its run is LIVE.** Take the lock FIRST,
   then inject, then run, then restore in a `trap`. An injection applied before
   waiting for the lock sits in a shared tree while other writers gate and commit.
6. **Keep the raw log, and never pipe a check through `tail`/`head`.** Piping
   destroys the failing evidence (the test's name and its expected/received block)
   and — because a pipeline's exit status is the *last* command's — `check | tail`
   returns success whatever the check did, so an `&& commit && push` chain lands
   unverified work beneath a message claiming a pass.
7. **Pick the cheapest tier that answers the question the change actually asks.**
   Beware the PARITY trap: a diff taken against the remote base is **empty** once
   everything is pushed, so a "docs-only" skip can silently become a full run —
   decide the tier from what **changed**.

## What a gate result must carry into the record

The summed counts, the peak, and the exit code — quoted, not paraphrased. A gate
result without its numbers is a claim, not evidence. See
[`BOARD.md`](BOARD.md) for the `LANDED` record that carries them.
