# `duplicate-candidates` — name-based Type-4 clone discovery

`npm run dup:candidates`
`node tools/duplicate-candidates/find-duplicate-candidates.mjs [--src DIR] [--report FILE] [--ext a,b,c] [--max N] [--ignore a,b,c] [--no-ignore] [--generated VALUE]`

A dependency-free scanner that finds **function-like declarations sharing an
exact, normalised or near-identical name across different files**, and emits them
as a **candidate list for human review**. It is a pointer, not a judge.

---

## The problem it solves

The standard duplication gates are **token-based** (`jscpd`, PMD CPD, SonarQube and
friends). They find **contiguous identical token runs**, which makes them precise and
cheap — and structurally blind to two functions that do the same job written
differently, a "Type-4 clone" in the standard clone taxonomy:

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

## The established methods — and where this tool fits

Duplicate-code detection is a mature field with a standard vocabulary. Knowing the
vocabulary is what makes this tool's niche precise: it is an **extension** to the
established methods, aimed at the one angle they do not cover.

### The clone taxonomy (Type 1–4)

| Type | Also called | What it is |
| --- | --- | --- |
| **1** | exact | Identical fragments, except whitespace, comments and formatting. |
| **2** | renamed / parameterised | Identical structure, but identifiers, literals or types were renamed. |
| **3** | near-miss / gapped | Copies with statements added, removed or changed — still recognisably the same. |
| **4** | semantic | Same *functionality*, different *implementation*. No shared token run, no shared syntax tree. |

Each type up is harder to detect, and the cost rises sharply. Almost every tool that
is practical in CI stops at Type 2 or 3.

### The detection families

| Family | How it matches | Representative tools | Reaches |
| --- | --- | --- | --- |
| **Text / line-based** | Normalised lines, then string matching | `diff`-based scripts, Duploc, Simian | Type 1 (Type 2 if normalised) |
| **Token-based** | Lex to tokens, then suffix trees / hashing / Rabin–Karp / Smith–Waterman | **jscpd**, **PMD CPD**, **SonarQube / SonarCloud**, CCFinderX, iClones, SourcererCC | Types 1–2, some 3 |
| **AST / tree-based** | Parse, then isomorphic subtrees or structural fingerprints | NiCad, Deckard, CloneDr, JetBrains DupFinder, **`eslint-plugin-sonarjs` → `no-identical-functions`** | Types 1–2, some 3 |
| **Graph-based** | Program / control dependence graphs | Duplix and research prototypes | Types 3–4, but expensive and language-bound |
| **Metric / fingerprint** | Per-function metric vectors, then clustering | various research and commercial tools | Type 3, heuristically |
| **Learning / embedding-based** | Neural code embeddings, learned similarity | CodeBERT / GraphCodeBERT-based detectors, ASTNN | Type 4, research-grade and probabilistic |

Practical reality for a JS/TS repo: the drop-in options are **jscpd** (token-based) and
**`sonarjs/no-identical-functions`** (lint-integrated, flags identical function
bodies). PMD CPD and SonarQube are equally established and worth it if you already run
that stack. The graph- and ML-based routes are where Type 4 is genuinely attacked, but
they are research-grade or need real infrastructure — not a one-line CI gate.

### Where this tool fits

Every family above matches **structure**: tokens, trees, graphs or vectors. This tool
matches **names**. That is a different signal, and it is the gap it exists to fill:

- A function that was **rewritten** but kept its name has no identical token run and
  no isomorphic subtree, so the token- and AST-based families report nothing. The name
  still says "these two are the same thing". This tool surfaces exactly those.
- It also catches the "same name, drifted bodies" case — two services each growing
  their own `addLogEntry`, similar enough to recognise, different enough that a token
  detector comes back clean.
- It is **not a Type-4 detector**. It is a cheap, explainable *heuristic* for Type-4
  discovery, and it is blind to a duplicated body under two unrelated names
  (`formatName` vs `buildDisplayName` — the example above). No cheap method catches
  that; the expensive families only catch it statistically.

So the two are complements, not competitors:

| Clone type | Standard method | This tool |
| --- | --- | --- |
| 1 — exact | token / text based: definitive | lists same-name pairs, but that is not its purpose |
| 2 — renamed | token / AST with normalisation | its **normalised** and **near** tiers match renamed *names*; body `sim` is a hint |
| 3 — near-miss | AST (NiCad, Deckard), tolerant token matchers | not found by body — only if the names still match |
| 4 — semantic, **same name** | effectively unreached by practical tools | **its angle** |
| 4 — semantic, **different names** | graph / ML, research-grade | **not covered** — see §Known limitations |

### What to run alongside it

1. **A token-based detector for Types 1–2** — cheap, precise, and safe to gate in CI
   (`jscpd`, PMD CPD, SonarQube). This is the baseline; run it first.
2. **A lint-integrated identical-body check** — `eslint-plugin-sonarjs` →
   `sonarjs/no-identical-functions`, if you want it on every commit rather than in a
   separate job.
3. **This tool for the name-based angle** — a reading list for the rewrites the above
   cannot see. Do not make it a gate: it points, it does not judge.
4. **Graph- or ML-based tooling only when the payoff justifies the setup** — the
   honest route to renamed-body Type 4, and still probabilistic.

---

## How it works

1. **Scan.** Walk the source root for **`.ts`, `.js`, `.mjs` and `.cjs`** files
   (`--ext a,b,c` replaces that list). Skip `*.d.ts` and the tests/specs of every
   supported extension (`*.test.ts`, `*.spec.mjs`, …), plus `node_modules`, `dist*`
   and every symlink (nothing outside the repo is followed). `.tsx`/`.jsx`/`.vue`/
   `.svelte` are deliberately **not** scanned — the tokenizer does not understand
   markup blocks, so it would report fabricated functions rather than miss them
   silently. Comments, strings, template literals and regex literals are masked out
   **before** parsing, so text inside them can never create a fake function. Brace
   depth bounds each body.
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
name, then file/line — and the report is **byte-identical across runs over the same
tree**, so two runs diff cleanly. See §Determinism below.

### Determinism

The scan itself is fully ordered: directory entries are sorted, function records are
sorted by `file`/`line`/`name`, and every comparator uses code-unit (`<` / `>`)
comparison rather than a locale-sensitive one. The report carries **no wall-clock
timestamp by default**, so re-running over an unchanged tree produces a byte-identical
file and a diff shows only real changes.

Provenance is **opt-in**, and you supply the value — which keeps a stamped report
reproducible too:

```bash
node tools/duplicate-candidates/find-duplicate-candidates.mjs \
  --src src --generated "$(date -u +%FT%TZ)"
```

`--generated VALUE` adds one `- Generated: VALUE` line; omitted, nothing is stamped.
This is rule 7 of `tools/README.md`. The default must stay deterministic, so never
reintroduce a `new Date()` default.

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

### The ubiquitous-name filter flags

| Flag | Effect |
| --- | --- |
| *(none)* | use `DEFAULT_IGNORED_NAMES` |
| `--ignore a,b,c` | **replace** the list with exactly `a,b,c` (not extend it) |
| `--no-ignore` | disable filtering entirely — reproduces the unfiltered tier counts exactly (`12313` tier-1 pairs here, vs `867` filtered) |

`--no-ignore` is the proof that the list is a convenience, not a cover-up;
`--help` lists every flag (including `--generated`).

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
- **Languages.** `.ts`, `.js`, `.mjs` and `.cjs` are scanned — widen or narrow the
  set with `--ext a,b,c`. **`.tsx`/`.jsx`/`.vue`/`.svelte` are not**, by design:
  they interleave markup with code, the tokenizer does not understand markup blocks,
  and a silent half-parse would be worse than a stated gap. Those need a real
  extractor, or a pre-pass that pulls out the `<script>` block.
- **The `sim` hint is coarse.** Shape Jaccard on token sets is deliberately cheap;
  two functions can share it while doing different things, and vice versa.

---

## HowTo — what to do with a candidate

Do **not** treat the list as a work queue. Treat it as a **reading list**: a candidate
is a question, not a task. The same strategy is printed at the end of stdout and
written into the generated report, so it travels with the candidate list.

**Step 0 — open both functions and compare intent.** The report gives `file:line` for
each; read them side by side, not just their signatures. Ask: *if one changes, must
the other change too?* If **no**, they are coincidentally-named twins or genuinely
different jobs — leave them, or rename one so the difference is obvious (often the
right call for same-named `render`/`init`). If **yes**, it is real duplication, and
there are exactly **two ways** to resolve it.

### Way 1 — literally the same thing ⇒ keep one, delete the other

The two bodies do the *same job*: same inputs, same outputs, same edge cases. The
answer is easy — **keep one and delete the other.**

- Keep the **better** of the two (clearer, better named, fewer surprises), not
  whichever you happened to open first.
- Check **every call site** before deleting, including exported/public names that may
  be used outside the files you can see; point them at the survivor.
- Look for the **near-invisible differences** that mean it is *not* literally the
  same: off-by-one bounds, `<` vs `<=`, null/undefined handling, a swallowed error, a
  different default. Finding one does not block the merge — it moves you to Way 2.
- Run the project's gate afterwards. Deletion is where a subtly-different caller
  breaks.

### Way 2 — big, almost-duplicate, one twist ⇒ add one parameter

The two are **large and nearly identical**, differing in one respect. Do not maintain
two copies that will drift: introduce **one parameter** that expresses the difference,
and let the single function do both.

- This pays off **because the body is big** — a large duplicated body is expensive to
  keep in sync. A *short* almost-duplicate is usually cheaper left alone, or shared as
  a tiny helper, than turned into something with an extra flag.
- Give the parameter a **default that reproduces today's behaviour**, then migrate
  call sites **one at a time**, so every intermediate state keeps working.
- The parameter must express a variation of **one job**. If the "twist" really makes
  the function do two different things, or you need several flags to cover the
  variants, you have two functions wearing one name — keep them separate, or factor
  out the part they genuinely share.
- **Test both settings.** Parameterisation is exactly where behaviour quietly changes.

### Or: leave it

Not de-duplicating is a legitimate, recorded outcome — when the similarity is
cosmetic, or the two really are different jobs that happen to share a name. What is
never acceptable is merging or deleting a candidate merely to make the list shorter.

### Working rules for the change itself

- **This is refactoring on a mature app.** Every deletion and every parameterisation
  is a change to working code with regression risk. Prefer small, individually
  verifiable steps; **run the project's own gate** after each; do not fold "cleanups"
  into unrelated feature work.
- **Delete the candidate from the list only when it is resolved** (merged, renamed, or
  consciously accepted). A shrinking, hand-maintained list is more useful than a huge
  auto-generated one nobody reads — but never delete a candidate to make the numbers
  look better.

---

## Files

- `find-duplicate-candidates.mjs` — the tool (CLI + exported pure helpers).
- `find-duplicate-candidates.test.mjs` — `node:test` unit tests for the helpers
  and the pruning rules, plus an end-to-end run over a `mkdtempSync` fixture.
- `../../tools/README.md` — folder rules and the port-to-another-project checklist.
