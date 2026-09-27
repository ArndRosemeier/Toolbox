# `scaffold/` — the day-1 machinery for a new project

Copy this into a new repo **before writing feature code**. It is the minimum the
chief-of-staff role needs *on disk* to run the process described in
[`../docs/WAY-OF-WORKING.md`](../docs/WAY-OF-WORKING.md): a board, a decision
ledger, one gate command and a brief template.

**Why day 1.** A process added later is a process nobody follows. Each file here
exists because its absence cost real work in a project that learned it the hard way
— the reasons travel with the files, on purpose.

These are **templates, not a framework**: plain markdown and two small shell
scripts. Nothing here is a dependency, and nothing is project-specific — the stack
commands are the only thing you must fill in.

## What to copy where

| Copy | To | Then |
| --- | --- | --- |
| `AGENTS.md.template` | `<repo>/AGENTS.md` | fill the stack line; keep every rule |
| `BRIEF.md` | `<repo>/docs/BRIEF.md` | the template every writer brief is cut from |
| `docs/BOARD.md` | `<repo>/docs/BOARD.md` | set the repo/branch, delete the sample rows |
| `docs/DECISION-LEDGER.md` | `<repo>/docs/DECISION-LEDGER.md` | keep the header; append rows as decisions are made |
| `scripts/gate.sh` | `<repo>/scripts/gate.sh` | set `GATE_CHEAP_CMD` / `GATE_FULL_CMD`; `chmod +x` |
| `scripts/board.sh` | `<repo>/scripts/board.sh` | set `BOARD_FILE` / remote / branch; `chmod +x` |

The `.template` suffix on the project-rules file is deliberate: an `AGENTS.md` in
this repo would be auto-loaded as binding instructions for the `scaffold/` subtree,
which a template must never be. Rename it on copy.

## Add to the project's `.gitignore`

```
/.gate-logs/
/.gate-lock/
/worktrees/
```

## The acceptance test for day 1

The scaffold is installed when both of these hold:

```bash
bash scripts/board.sh            # → BOARD RECONCILED
GATE_TESTS=0 bash scripts/gate.sh; echo $?   # → 2  (cheap tier green, suite NOT run)
```

`2` is the correct answer here, not a failure: it means the cheap tier passed and
the expensive tier did not run. It must never be quoted as "the gate passed".

`board.sh` reconciles against the **remote** branch, so push once before expecting
`BOARD RECONCILED`. With no remote it says `CANNOT LOOK` and exits 1 — loudly, which
is the correct behaviour for a check that cannot see reality.

## Add the rest when you meet the failure

The full process has more mechanics — probes, the seam index, differential
verification, worktree recipes, host ceilings. **Do not build them all on day 1.**
Each was added after a specific failure; add it when you meet that failure. What
must exist on day 1 is exactly the four artifacts named above, because everything
else presupposes them.

## If the project already has equivalents, they win

This scaffold is a starting point. A project's own `AGENTS.md` and docs are the
authority for its mechanics — adapt the files here rather than overriding a
project's existing, better-informed rules.
