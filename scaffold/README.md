# `scaffold/` — the day-1 files that are not documents

The process documentation lives in [`../docs/`](../docs/README.md). This folder holds
the copy-ready files that are **not** documents: the project-rules template and the
two scripts that implement the [gate](../docs/GATE.md) and the board's reconciler.

Copy them into a new repo **before writing feature code**. The full day-1 list —
documents included — is in [`../docs/README.md`](../docs/README.md).

| Copy | To | Then |
| --- | --- | --- |
| `AGENTS.md.template` | `<repo>/AGENTS.md` | fill the stack line; keep every rule |
| `scripts/gate.sh` | `<repo>/scripts/gate.sh` | set `GATE_CHEAP_CMD` / `GATE_FULL_CMD`; `chmod +x` |
| `scripts/board.sh` | `<repo>/scripts/board.sh` | set `BOARD_FILE` / remote / branch; `chmod +x` |

And the documents, out of `../docs/`:

| Copy | To |
| --- | --- |
| `docs/BOARD.md` | `<repo>/docs/BOARD.md` |
| `docs/DECISION-LEDGER.md` | `<repo>/docs/DECISION-LEDGER.md` |
| `docs/SEAM-INDEX.md` | `<repo>/docs/ARCHITECTURE.md` |
| `docs/TESTING.md` | `<repo>/docs/TESTING.md` |
| `docs/BRIEF.md` | `<repo>/docs/BRIEF.md` |

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

The full process has more mechanics — probes, differential verification, worktree
recipes, host ceilings. **Do not build them all on day 1.** Each was added after a
specific failure; add it when you meet that failure. What must exist on day 1 is the
board, the decision ledger, one gate command and a brief template, because everything
else presupposes them.

## If the project already has equivalents, they win

This scaffold is a starting point. A project's own `AGENTS.md` and docs are the
authority for its mechanics — adapt these files rather than overriding a project's
existing, better-informed rules.
