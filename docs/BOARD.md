# The board — what is happening right now

**This file is the state of record.** It is true *before* any report reaches the
owner. A successor session must be able to act within minutes from this file plus
`git log --oneline -10 origin/<branch>` and `git worktree list`.

**One screen, overwritten in place.** A record that no longer describes the present
belongs in the decision ledger or nowhere.

## The contract

1. **Updated in the same commit as the landing it records.**
2. **True BEFORE the dispatcher reports to the owner.** If the session dies the
   second after that report, a successor must be able to act from this file, the
   ledger, and git alone.
3. **Every record names something checkable** — sha, branch, worktree, session id,
   path. "Probably fine" is not a record.
4. **Session start = reconcile first** (`bash scripts/board.sh`). Read it, check it
   against reality, fix what lied, report ONE line, and only then dispatch.
5. **Reconcile against the REMOTE branch, never a stale local one.** A landing once
   read as "unlanded" for hours while it was pushed and five commits ahead of a
   stale local branch.

## Record vocabulary

One line per record, `PREFIX | field=value | …`, so a query is a `grep` and the
answer is a line, not a paragraph.

| Prefix | Means |
| --- | --- |
| `reconciled: <sha> · <timestamp>` | the commit the rest of this file was checked against |
| `SESSION` | an actor that may dispatch (id, model, state) |
| `PROBE` | a read-only agent in flight and the question it answers |
| `IN-FLIGHT` | a writer: row, session, worktree, branch, base, **state**, and the full scope |
| `LANDED` | a verified landing: row, sha, **the dispatcher's own verification numbers**, what was retired, the docs amended |
| `QUEUE` | owner requests and known debt not yet dispatched, with the row number reserved |
| `QUEUE-CLOSED` | a queue line whose scope is consumed (kept one screen, then dropped) |
| `TRAP` | a mistake that actually happened, with the rule that prevents it |
| `GUARD` | a mechanism protecting the process (host, memory, compaction) and how to verify it |
| `RECOVERY` | where a successor finds lost context |

---

## Board

<!-- Replace the sha/branch below; delete the samples once real records exist. -->

```
reconciled: <sha-of-origin/main> · <YYYY-MM-DDTHH:MMZ>

SESSION | id=<session-id> | model=<provider>/<model> | state=<idle|dispatching|waiting>

QUEUE | row=1 | <the owner's request, in one line> | src=<where the detail lives>

RECOVERY | repo=<absolute path> | remote=<url> | branch=<main> | gate=bash scripts/gate.sh
```

### Record format — one worked example

```
LANDED | row=7 | sha=<40-hex> | verify=MY OWN: cheap tier green (exit 2) + full gate
  GREEN · <N>/<N> tests · peak <N>MB | arms=<hash-a> vs <hash-b> — arm B red on
  <named pin> | retired=branch <name> + worktree <path> + session <id> | docs=ledger
  row 7, board | note=<one line>
```

## Guards

<!-- Mechanisms that protect the process, each with how to verify it. -->

- **`GUARD` — the suite lock.** `scripts/gate.sh` takes an atomic `mkdir` lock; a
  second run is refused (exit 9) and is VOID. Verify: run a gate twice.
- **`GUARD` — the memory ceiling.** Every expensive run carries one. Verify:
  read the runner's cap variable and the peak it printed.

## Recovery pointers

- Repo / remote / branch:
- The gate command and its exit codes (`0` green · `1` failed · `2` cheap only ·
  `9` refused, VOID):
- Where the raw logs live:
- Open writer branches/worktrees: `git worktree list` · `git branch -a`

## Traps (each with the rule that prevents it)

<!-- A TRAP is a mistake that ACTUALLY HAPPENED. Keep it short and concrete. -->

- `TRAP` — <what went wrong, in one line>. Rule: <the rule>.
