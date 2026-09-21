# `duplicate-candidates` — name-based Type-4 clone discovery

`npm run dup:candidates`
`node tools/duplicate-candidates/find-duplicate-candidates.mjs [--src DIR] [--report FILE] [--max N] [--ignore a,b,c] [--no-ignore]`

A dependency-free scanner that finds **function-like declarations sharing an
exact, normalised or near-identical name across different files**, and emits them
as a **candidate list for human review**. It is a pointer, not a judge.

---

## The problem it solves

This project's existing duplication gate is `jscpd`
(`npm run duplication:check`). `jscpd` finds **contiguous identical token runs**.
That makes it structurally blind to two functions that do the same job written
differently — a "Type-4 clone" in the standard clone taxonomy:

```ts
// A.ts
function formatName(user: User) {
  return `${user.first} ${user.last}`.trim();
}

// B.ts
function buildDisplayName(u: User) {
  const parts = [u.first, u.last];
  return parts.filter(Boolean).join(' ');
}
```

No identical token run exists, so `jscpd` reports nothing. But the two functions
are the same idea twice, and in a codebase with a long "vibe coding" history
there are hundreds of these. `duplicate-candidates` closes the **discovery** gap
cheaply: it cannot decide equivalence, but it can point a human at the places
worth reading.

---

## How it works

1. **Scan.** Walk the source root for `.ts` files. Skip `.d.ts`, `*.test.ts`,
   `*.spec.ts`, `node_modules`, `dist*`, and every symlink (nothing outside the
   repo is followed). Comments, strings, template literals and regex literals are
   masked out **before** parsing, so text inside them can never create a fake
   function. Brace depth bounds each body.
2. **Extract** every function-like declaration — `function foo`, `async function
   foo`, class and object-literal methods (with `public|private|protected|static|
   readonly` and optional return types), arrow/function expressions assigned to
   `const`/`let`, and getters/setters — recording name, file, 1-based start line,
   body token count and a body **shape** (token sequence with every identifier
   replaced by `ID`, numbers by `NUM`).
3. **Group into three tiers**, each pair appearing in exactly one tier — the
   strongest that applies — across *different* files:
   - **Tier 1 — exact name match.** `addLogEntry` / `addLogEntry`.
   - **Tier 2 — normalised name match.** Lowercase, `_` and `$` removed, so
     `addLogEntry` / `add_log_entry` / `AddLogEntry` all match.
   - **Tier 3 — near name match.** Names are split into words
     (`addLogEntry` → `add log entry`), common affixes (`get`, `set`, `handle`,
     `on`, `try`, `do`, `make`, `create`, `build`, `update`, `process`, `render`,
     `load`, `save`, `init`, `is`, `has`, `can`, `should`) are stripped, and then
     a pair matches if the remaining token sets are equal or the normalised
     strings are within a small edit distance.
4. **Compare bodies only as a HINT**, with pruning (below), and sort each tier by
   that hint descending.
5. **Filter ubiquitous names from the default listing** (see below). Pairs whose
   *every* name is structurally expected to repeat are moved out of the inline
   tiers, **counted**, and written to their own report section. Nothing is dropped.

---

## Example output

```
Duplicate-function CANDIDATES (name-based discovery — NOT verdicts)
...
Scan: 236 files scanned, 3389 function-like declarations found, 0 skipped
Tiers: 867 exact, 12 normalised, 1842 near (each pair appears once, in its strongest tier; ubiquitous-name filter ON (20 names; --no-ignore disables))
Ignored as ubiquitous: 11446 pairs (constructor: 9043, render: 1594, setupEventListeners: 171, destroy: 153, open: 120, cleanup: 102, getInstance: 91, close: 77, initialize: 66, clear: 28, attachEventListeners: 1)
Evidence pruning: 14167 candidate comparisons
  fully compared: 2552 (18.0%)
  confirmed early (high end): 2162 (15.3%)
  ruled-out (size, bodies NOT tokenised): 9374 (66.2%)
  ruled-out (disjoint, partial walk): 79 (0.6%)
  shape sets built: 938 function(s) of 3389; shape tokens examined: 35172
Report: reports/duplicate-candidates.md
Ignored pairs are counted above and listed IN FULL in the report under "Ignored candidates" —
nothing is silently dropped; re-run with --no-ignore to see them inline, or with --ignore a,b,c to retune.

== TIER 1 — EXACT name match across different files (867 pairs) ==
  buildContentStyle()  sim=1.00  src/ui/modals/NodeInspectorModal.ts:85  <->  src/ui/modals/TagManagerModal.ts:54
  getLanguage()  sim=1.00  src/ProjectManager.ts:112  <->  src/SettingsManager.ts:759
  getModalStyles()  sim=1.00  src/idea-board/ui/TransformModal.ts:82  <->  src/ui/components/TextTransformModal.ts:89
  escapeHtml()  sim>=0.75 (confirmed early)  src/DiffTool.ts:142  <->  src/idea-board/ui/TransformModal.ts:413
  addLogEntry()  sim>=0.60 (confirmed early)  src/AILogService.ts:44  <->  src/ErrorLogService.ts:45
  ...
```

Line shape: `name()` — `evidence` — `file A:line` — `file B:line`. Stdout caps each
tier at 60 pairs so it stays readable; the full list (including every ignored pair)
is always in `reports/duplicate-candidates.md`. Use `--max N` for more on stdout,
e.g. `node tools/duplicate-candidates/find-duplicate-candidates.mjs --max 20000`.

The markdown report opens with the scan stats and a plain statement that these are
candidates requiring human review. Ordering is stable — similarity desc, then
name, then file/line — so two runs diff cleanly.

### The `sim` hint

`sim` is the **Jaccard similarity of the two bodies' shape token-sets**
(2 decimals). It is meaningful **only because the names already match**: it tells
you whether the two same-named functions even look alike. It is not a verdict and
must never be quoted as one. `sim>=X (confirmed early)` means the comparison was
stopped on a guaranteed lower bound; a plain `sim=X` is exact.

---

## The evidence stage: aggressive early exits

Computing a real similarity for all ~14k candidate pairs would be wasteful, so the
body-evidence stage is **prune-first** and records *why* it stopped:

| Prune reason | Rule | What it means |
| --- | --- | --- |
| `ruled-out (size)` | shorter body is **< 50 %** of the longer body's token count | cannot be the same function; the bodies are **never tokenised at all** |
| `ruled-out (disjoint)` | walking the shape sets, the ceiling `(intersection + remaining) / union` drops below the reporting floor (default `0.30`) | even a perfect remainder cannot reach the floor; the walk stops mid-set |
| `confirmed` | the guaranteed lower bound `intersection / union` already clears the confirm floor (default `0.60`) | a strong match, stopped early on the high end |
| `compared` | neither early exit fired | the walk completed; `sim` is exact |

The printed counters are the evidence that the exits are real, not cosmetic: how
many comparisons ended in each bucket, how many shape sets were ever built (938 of
3389 functions on this repo), and how many shape tokens were actually examined.

On this codebase the counters read: **66.2 % ruled out by size without
tokenising**, 15.3 % confirmed early, 0.6 % ruled out as disjoint, 18.0 % fully
compared. A tool that claimed to prune but compared everything would show 100 %
"fully compared" and 2 × pairs shape sets built.

Pruned pairs are still **listed** — with the reason instead of a misleading score —
because dropping them silently would violate the "never silently miss" rule.

Thresholds (`--src` aside) live as exported constants in the script
(`DEFAULT_SIM_FLOOR`, `DEFAULT_CONFIRM_FLOOR`, `DEFAULT_SIZE_RATIO`) and can be
passed to the exported functions for experiments.

---

## The ubiquitous-name filter

Without a filter, tier 1 on this repo is **73 % `constructor()`** (9043 of 12313
pairs), and the handful of genuinely interesting candidates — `escapeHtml`
repeated across several files, `addLogEntry` duplicated in the two log services —
sink below the 60-pair stdout cap. A candidate list nobody can read is not doing
its job.

So names that are *structurally expected to repeat* are filtered from the
**default stdout listing**:

```js
// DEFAULT_IGNORED_NAMES — auditable and editable in the tool
constructor, render, destroy, componentDidMount, componentWillUnmount,
setupEventListeners, attachEventListeners, addEventListeners,   // lifecycle/boilerplate
open, close, cleanup, clear, initialize, init, getInstance,     // ubiquitous API surface
toString, valueOf, main, handler, handleEvent                   // language/runtime callbacks
```

Why these: every component/class has its own `constructor`/`render`/`destroy` by
construction; singletons and UI widgets repeat `getInstance`/`open`/`close` by
convention; `toString`/`valueOf`/`main`/event handlers are prescribed by the
language or the runtime. A shared name there carries almost no duplicate signal.

**Nothing is hidden.** The filter is a display convenience, and the tool stays
honest about over-reporting:

- Ignored pairs are **counted** and printed: `Ignored as ubiquitous: 11446 pairs
  (constructor: 9043, render: 1594, …)` — in stdout **and** in the report.
- Ignored pairs are **still written to the report**, in full, under their own
  clearly-labelled section (`## Ignored candidates — ubiquitous names`), with the
  same evidence column as everything else.
- A pair is filtered only when **every** one of its names is on the list, so a
  near-match like `open` / `openDocument` is kept: only one half is boilerplate.
- The tool calls itself a pointer, not a judge; the filter never turns it into a
  tool that quietly drops things.

### The three CLI flags

| Flag | Effect |
| --- | --- |
| *(none)* | use `DEFAULT_IGNORED_NAMES` |
| `--ignore a,b,c` | **replace** the list with exactly `a,b,c` (not extend it) |
| `--no-ignore` | disable filtering entirely — reproduces the unfiltered tier counts exactly (`12313` tier-1 pairs here, vs `867` filtered) |

`--no-ignore` is the proof that the list is a convenience, not a cover-up;
`--help` lists every flag.

---

## Known limitations (stated plainly)

- **Same name is not proof.** Two unrelated `render()` methods are legitimately
  reported. Expect hundreds of tier-1 pairs on this repo even after the ubiquitous
  filter (867 of 12313); most are still noise.
- **Name-first, so it is blind to a duplicated body under two unrelated names.**
  `formatName` vs `buildDisplayName` above will **not** appear. Catching that needs
  a different (AST/embedding) tool.
- **It does not detect moved or extracted code** — a function relocated to a new
  file, or one body split into two helpers, is out of scope.
- **Heuristic parser.** Decorators or exotic syntax can defeat the brace/paren
  matcher. Such files are skipped and counted (the `skipped` number in the stats),
  never fatal — but check that count when it is non-zero.
- **Only `.ts`.** `.tsx`/`.jsx`/`.vue`/`.svelte` are not scanned by default and
  would need extractor changes.
- **The `sim` hint is coarse.** Shape Jaccard on token sets is deliberately cheap;
  two functions can share it while doing different things, and vice versa.

---

## What to do with a candidate

Do **not** treat the list as a work queue. Treat it as a reading list.

1. **Open both functions** (the report gives `file:line` for each). Read them side
   by side, not just their signatures.
2. **Compare intent, not text.** Ask: if one of these changes, must the other
   change too? If yes, that is real duplication. If no, they are coincidentally
   named twins and should be left alone.
3. **Decide, explicitly:**
   - **Extract** into one shared helper — when the intents genuinely coincide.
   - **Differentiate** — rename one so their different jobs are obvious (this is
     often the correct answer for same-named `render`/`init` methods).
   - **Leave** — when the similarity is cosmetic.
4. **Remember this is refactoring on a mature app.** Every extraction is a change
   to working code with regression risk. Prefer small, individually verifiable
   steps; run the project gate (`bash scripts/gate.sh`) after each; do not fold
   "cleanups" into unrelated feature work.
5. **Delete the candidate from the list only when it is resolved** (extracted,
   renamed, or consciously accepted). A shrinking, hand-maintained list is more
   useful than a huge auto-generated one nobody reads — but never delete a
   candidate merely to make the numbers look better.

---

## Files

- `find-duplicate-candidates.mjs` — the tool (CLI + exported pure helpers).
- `find-duplicate-candidates.test.mjs` — `node:test` unit tests for the helpers
  and the pruning rules, plus an end-to-end run over a `mkdtempSync` fixture.
- `../../tools/README.md` — folder rules and the port-to-another-project checklist.
