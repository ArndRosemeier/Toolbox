# The decision ledger

**Append-only.** A decision is history; history never rots. Never edit another
landing's row — if a decision is superseded, add a new row that says so and points
at the old one.

**This is not a behaviour doc.** Docs that *restate behaviour* rot; docs that
*record decisions* do not. Behaviour lives in a test (the test **is** the
statement); this file holds the decision, the reason, and the pointer to the test.

## The rule for a row

1. **Quote the owner verbatim** when the decision is theirs. The verbatim words are
   what stops a later slice from re-litigating it.
2. **Name the evidence** — the file:line, the measurement, the incident — at the
   commit it was true.
3. **Say what was rejected**, and why. A decision without its rejected alternative
   gets re-proposed.
4. **Say what is still unproven.** An honest unknown is worth more than a confident
   guess.

## Row numbers are assigned by the dispatcher

The dispatcher reads this file at brief time and puts the row number **in the
brief**, so two concurrent writers cannot claim the same one. A writer that still
hits a docs conflict renumbers its OWN row only and touches nothing of the other
landing.

---

## Ledger

| n | statement | files | why | status |
| ---: | --- | --- | --- | --- |
| 1 | **<the decision, in one sentence>** — owner, verbatim: *"<their words>"*. Evidence: `<file:line>`, measured `<date>`. Rejected: `<the alternative>`, because `<reason>`. Unproven: `<what we do not know yet>`. | `<paths>` | <the problem it solves> | LANDED `<sha>` / OPEN |

<!--
Copy the row above for each new decision. Keep it to one row's worth of prose: the
detail belongs in the commit, the test, or the seam index — this is the pointer.
-->
