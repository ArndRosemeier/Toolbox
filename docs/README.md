# The shared layer — documentation

This folder is the **process documentation** for these projects: the way work gets
planned, briefed, verified and recorded. It sits **below** any single app — nothing
here depends on one project, which is why the chief-of-staff role points *here*
rather than into an app's folder.

## Read first

| Doc | What it is |
| --- | --- |
| [`WAY-OF-WORKING.md`](WAY-OF-WORKING.md) | The process itself. **Part 1** is the portable strategy (roles, the loop, the durable artifacts, verification doctrine, the brief). **Part 2** is the concrete DeepSeek Harness mechanics (the clock and the gate, worktrees, subagent and host hygiene). Start here. |

## The durable artifacts

Everything that matters lives on disk. One doc per artifact — each explains the
pattern **and** carries the skeleton you copy into a project.

| Doc | Answers | Copy into a project as |
| --- | --- | --- |
| [`BOARD.md`](BOARD.md) | *What is happening right now?* | `docs/BOARD.md` |
| [`DECISION-LEDGER.md`](DECISION-LEDGER.md) | *Why is it like this?* | `docs/DECISION-LEDGER.md` |
| [`SEAM-INDEX.md`](SEAM-INDEX.md) | *How does the code work, and where is the ONE way to do X?* | `docs/ARCHITECTURE.md` |
| [`TESTING.md`](TESTING.md) | *What proves this, and what was actually run?* | `docs/TESTING.md` |

Why these four and not more: docs that **restate behaviour** rot, docs that **record
decisions** do not. So behaviour lives in a test (the test *is* the statement), and
these docs hold the decision, the pointer and the reason. Each has a different
lifetime — decisions never rot · seams are checkable · state is one screen ·
behaviour is the test.

## Running a slice

| Doc | What it is |
| --- | --- |
| [`GATE.md`](GATE.md) | The one gate command: two tiers, the atomic lock, the exit-code vocabulary, and the rules around it. |
| [`BRIEF.md`](BRIEF.md) | The writer brief template, and the dispatcher's pre-send checklist. |

## The day-1 files that are not documents

The copy-ready **non-document** files live in [`../scaffold/`](../scaffold/README.md):
the project-rules template (`AGENTS.md.template`) and the two scripts that implement
[`GATE.md`](GATE.md) and the board's reconciler.

## If a project already has equivalents, they win

This is a starting point, not an override. A project's own `AGENTS.md` and docs are
the authority for its mechanics — adapt what is here rather than overriding rules
that a project learned the hard way.
