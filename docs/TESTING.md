# Testing — what proves this, and what was actually run

This doc exists because **"it compiles" is never "it passed"**, and because a green
result whose evidence was discarded cannot be diagnosed. It records the pins, the
differential arms with their hashes, and the VOID probes — per landing, as they were
actually run.

It is not a test plan. It is the record of what *proves* the behaviour, and of what
was *executed*.

## The pin

A **pin** is a test that goes red when the behaviour it protects is broken. Three
rules make a pin worth having:

1. **A test's NAME is part of the deliverable.** A pin that reds must say what it
   protects. Green with no name is unverifiable later.
2. **A pin must be watched red at least once.** A test that has never failed against
   a broken implementation has not been shown to hold anything — that is what the
   differential below is for.
3. **Reuse the existing harness.** A second fixture set for the same idea is
   duplication that drifts (see [`SEAM-INDEX.md`](SEAM-INDEX.md)).

## The differential (the injection)

To prove a pin actually holds a property, break the property on purpose and watch
the pin go red. The arms are the runs; each has rules, and every one of them was
learned the hard way:

- **Print every arm's file hash.** A finished injection whose hash was not printed is
  not evidence.
- **Two arms with identical output are a VOID probe**, never evidence against a
  landing: the mutation did not change what ran. Identical arms are the *tell*, not
  the result.
- **A green arm whose mutation certainly changed behaviour is a WRONG-FILE or
  missing-pin signal FIRST.** Grep for the pin's own test file and run *that* file.
  Both recorded "pin-coverage gaps" were the runner's error, not the code's.
- **Restore from HEAD, and only the bytes HEAD actually holds.** `git checkout -- <path>`
  restores the *index*; a bare restore from HEAD in a tree whose change is still
  **uncommitted** WIPES the work. Either commit the slice first, or restore from an
  out-of-tree copy.
- **Take the lock before injecting, and restore in a `trap`.** An injection left in a
  shared tree while another writer gates can be committed by that writer.
- **The first arm is the untouched baseline**, and its hash should match the author's
  reported baseline. That is provenance, and it has caught verification against the
  wrong tree.

## What "verified" means

- The commit is on the **remote** branch, not the local tree.
- The **dispatcher's own** gate ran on the integrated tree, raw log kept, with the
  summed counts and peak quoted (see [`GATE.md`](GATE.md)).
- The **dispatcher's own** differential ran, arms hash-printed, at least one
  injection the author did not run.
- The docs were amended **in the same commit** as the change.

The author's gate proves the change does what the author *meant*. Only the
independent arm proves the pins hold the property. Both are needed.

## Skeleton

Copy into a project as `docs/TESTING.md`.

```markdown
# Testing — what proves this

## The pin matrix

| Behaviour | Pin (test) | Where | How it is watched red |
| --- | --- | --- | --- |
| <the property> | `<test name>` | `<file>` | <the mutation that reds it> |

## Raw logs

The gate writes to `<log dir>`. The raw log is kept until the landing is verified.
Never pipe a run through `tail`/`head`.

## Per landing

### <sha> — <row>

- **Gate:** <exit code> · <N>/<N> tests · peak <N>MB · raw log `<path>`
- **Differential:** arm A `<hash>` (baseline) · arm B `<hash>` → RED on `<named pin>`
- **VOID:** <any probe whose arms were identical, and therefore proved nothing>
```

## Honest records

A VOID probe, a wrong-file green, a discarded log and a verification run against a
stale tree are all **recorded, not hidden**. An honest unknown is worth more than a
confident green, and the failure modes above are information about the *process*, not
merely about the change.
