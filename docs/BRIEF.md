# Writer brief — the template

A brief is **self-contained**: the writer never sees the dispatcher's conversation.
Cut every brief from this file. The bracketed parts are what the dispatcher fills in;
the rest is binding text that should not be softened.

Two clauses in here do most of the work, and both should survive every edit:

- **"the brief may be wrong — prove it and report BLOCKED"** — it has caught real
  incorrect dispatcher designs.
- **"silence until LANDED or BLOCKED"** — it stops the report-churn that burns a
  writer's context.

---

```markdown
You are a WRITER on <project> (<stack, one line>). Read `<AGENTS.md>` FIRST — the
binding rules. Then read the specs and ledger rows for this area.

# Where you work (READ THIS TWICE)
Your worktree is <ABSOLUTE path, inside the repo> on branch <branch>, based on
origin/<main> = <sha>. Every bash call runs in a fresh shell whose cwd is the MAIN
repo, and file tools resolve RELATIVE paths against it — so EVERY read/edit/write/
bash call MUST use an ABSOLUTE path under <worktree> (or pass a working directory).
Never touch the main tree. <N> other writer(s) may be in flight; your source files
are disjoint.

# Your ledger row: <N>
A DOCS conflict is a mechanical UNION (renumber YOUR row only, touch nothing of the
other landing); a NON-docs conflict: STOP and report.

# The owner's report (verbatim) and the intent
"<paste the owner's words exactly>"
Then: the outcome the request is reaching for, and the MEASURED state of the code
today (`file:line`) — not a guess about it.

# What to build
One numbered list. Name the ONE seam it extends (<file:line> or the seam index
row). State the design decisions already made, and that you may prove wrong. Name
what is deliberately OUT of scope and why.

# Pins
The behaviours that must go red when broken, each phrased as a STATEMENT. Reuse the
existing test harnesses; never build a second fixture set. A pin's NAME is part of
the deliverable — it must say what it protects.

# Verification (yours)
1. The ONE gate command: `<the command>`. Keep the RAW log. Exit 9 = lock busy →
   WAIT and retry; never reap another actor's processes.
2. Your own differential: every arm's file hash PRINTED, the lock held before
   injecting, restore from HEAD in a `trap`. Two arms with identical output are a
   VOID probe, not evidence.
3. Commit style, then `<rebase command>` before pushing.
4. If you cannot finish, COMMIT the coherent partial state on your branch and report
   BLOCKED. Uncommitted work dies with the session.

# Docs to amend in the SAME commit
<ledger row N, seam index row if a seam moved, the testing doc section> — and carry
the `COPIES:` line (`COPIES: n→1 — <seam>` or `COPIES: 1 — checked (grepped: <what>)`).

# Your report (short)
LANDED or BLOCKED, then: sha; gate counts + peak; each arm with its printed hash and
what went red; the `COPIES:` line; how the deliverable actually works; your judgement
calls; the docs you amended; and anything this brief got wrong.

Report NOTHING in between — silence until LANDED or BLOCKED. If you can PROVE a rule
here is wrong (including this brief's own design), report BLOCKED with the evidence
rather than implementing it.
```

---

## Dispatcher's checklist before sending

- [ ] The intent is stated, not just the literal ask.
- [ ] The ONE seam is named, with its location.
- [ ] The ledger row number is assigned from the ledger **now**.
- [ ] The worktree path is absolute and stated twice.
- [ ] Out-of-scope items are named.
- [ ] Pins are phrased as statements, not as "test the feature".
- [ ] The `COPIES:` line is required in the report.
- [ ] The BLOCKED clause is present, including "the brief may be wrong".
