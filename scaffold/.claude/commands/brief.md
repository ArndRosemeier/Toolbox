---
description: Render a self-contained writer brief for one slice.
argument-hint: [the owner's request]
---

Cut the brief from `docs/BRIEF.md` — copy the template, fill every bracketed part,
and do not soften the binding text. The writer never sees this conversation.

The brief MUST carry:

1. **The owner's report, verbatim**, then the intent behind it.
2. **The ONE seam** the slice extends (`file:line` or the seam-index row), or why the
   slice is genuinely new.
3. **The worktree, ABSOLUTE**, and the branch based on the current remote sha. Say
   twice that every bash/file call uses an absolute path.
4. **The ledger row number**, assigned from the ledger now.
5. **Pins** — the behaviours that must go red when broken, each as a STATEMENT, each
   with a name that says what it protects.
6. **The gate command and the tier** the writer runs; exit-code meanings quoted
   exactly. DSH: a writer runs its gate in-turn (its background jobs die with its
   turn). Claude Code: the Task tool's background task is the equivalent.
7. **The cadence contract**: silence until LANDED or BLOCKED.
8. **The `COPIES:` line** the report must carry.
9. **"The brief may be wrong — prove it and report BLOCKED"**, including when the
   flaw is in the brief's own design.
10. **What is deliberately OUT of scope**, and why.

Before sending, run the pre-send checklist at the bottom of `docs/BRIEF.md`.
