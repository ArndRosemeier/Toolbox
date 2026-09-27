# The seam index — how the code works, and the one way to do X

The seam index answers *"how does this codebase work, and where is the ONE place
that does X?"* — the layer map, the seam rows, the gotchas and the known debt. It is
what a brief is scoped against and what a writer reads before touching an area.

The point of it: **duplication is invisible when a copy is BORN.** Nothing fails, and
each copy is correct where it was written. So the index is what makes "there is one
way to do this" a fact you can check rather than a thing everyone remembers.

## The rule

- **An index entry is CHECKABLE, never prose.** It names a seam and where it lives.
  "We agreed there is one way to do X" is not an entry; `escapeHtml — src/lib/text.ts:14`
  is.
- **Updated in the same commit as the change.** A landing that adds, moves or deletes
  a seam updates its row in that landing. An unamended seam is treated as missing.
- **A decision is history; a seam is the present.** Superseded decisions go to the
  [decision ledger](DECISION-LEDGER.md) and stay there. An index row that no longer
  describes the code is *wrong*, not historical — fix or delete it.
- **The index does not restate behaviour.** Behaviour lives in a test. The row holds
  the pointer.
- **Obligation before the work:** when a change touches more than one site, or the
  same idea is found written twice, the FIRST examination is whether one seam can
  carry it — never how to fix each copy. The answer is written down in the brief and
  the landing as the `COPIES:` line (see [`BRIEF.md`](BRIEF.md)).

## What a row must let a reader do

Given only the row, a reader should be able to answer: *where is the one place this
is done, what are the layer boundaries, and what will bite me if I touch it?* If the
row cannot answer that, it is describing the code instead of indexing it.

## Skeleton

Copy into a project as `docs/ARCHITECTURE.md`.

```markdown
# Architecture — the seam index

## 1 · Layer map

<One line per layer, and the direction dependencies are allowed to point.>

## 2 · The one way to do X

| Seam | The ONE way | Where | Notes |
| --- | --- | --- | --- |
| <the idea> | `<function/class/module>` | `<file:line>` | <what used to be duplicated, what bites> |

## 3 · Gotchas

- <something that looks wrong but is deliberate, with the reason>

## 4 · Known debt

- <what is wrong, what it costs, and what a fix would touch>
```

## Keeping it honest

The index is prose, so it can lie. Two habits keep it usable: a landing amends it in
the **same commit**, and the reconciler (see
[`../scaffold/scripts/board.sh`](../scaffold/scripts/board.sh)) checks the claims
that are mechanically checkable. An index nobody checks becomes decoration.
