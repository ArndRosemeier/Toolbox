# `repeated-code` — copies under any name, and copies with no name at all

`duplicate-candidates` asks *"do two functions share a name?"*. This tool asks the
two questions that name-matching cannot answer:

1. **Body clones under different names.** `clamp01` in one file, `saturate` in a
   second, `sat` in a third, all with the same body. Each function body is reduced
   to its *shape* (identifiers → `ID`, numbers → `NUM`), cut into 5-token shingles,
   hashed into a 64-value MinHash signature and bucketed with LSH (16 bands × 4
   rows). Only pairs that share a bucket are compared, with an exact Jaccard
   (≥ 0.7 by default), then clustered with union-find.
2. **Repeated idioms.** The same inline snippet, not wrapped in any function, pasted
   into many files: a hand-written "is this water?" test, a hand-made
   `damage = Math.min(1, damage + x)`, the five-line canvas-texture setup. Every
   window of 16 tokens is hashed with **property and method names kept**
   (`.isWater`, `.bridgeDeck`, `Math.hypot`) and local names erased. A window that
   recurs in at least 3 **different files** is a hit. Each hit is extended to its
   maximal shared run, and shifted or shorter variants of a run already reported are
   absorbed.

Idioms are ranked by **files × specificity**. Specificity is the sum of the IDF (in
bits, over files) of the distinct names kept in the snippet: `.x` is in every file
and says little, `.bridgeDeck` says a lot. Snippets below `--min-info` (6 bits by
default) are generic glue like `a.x - b.x, a.z - b.z`. They are **counted, written to
the report's "Filtered" section, and recoverable** with `--min-info 0`.

Like every tool here it is a **pointer, not a judge**: it lists candidates with
evidence and exits `0`.

## Run it

```
node tools/repeated-code/find-repeated-code.mjs
node tools/repeated-code/find-repeated-code.mjs --src app --report reports/repeated-code.md
node tools/repeated-code/find-repeated-code.mjs --min-files 4 --window 20 --max 50
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--src DIR` | `<repo>/src` | source root (same walker as `duplicate-candidates`: no symlinks, skips `node_modules`, `dist*`, `*.d.ts`, tests) |
| `--report FILE` | `reports/repeated-code.md` | markdown report |
| `--ext a,b,c` | `.ts,.tsx,.mts,.cts,.js,.jsx,.mjs,.cjs` | extensions to scan |
| `--window N` | 16 | idiom window in tokens. Smaller finds shorter idioms and more noise |
| `--min-files N` | 3 | an idiom must recur in N different files |
| `--min-info BITS` | 6 | idiom specificity floor; `0` lists everything |
| `--min-body N` | 40 | smallest function body (tokens) considered for body clones |
| `--clone-floor X` | 0.7 | body Jaccard that counts as a clone |
| `--max N` | 25 | entries per section on stdout (the report has all of them) |
| `--generated VAL` | — | stamp the report. Omitted by default, so runs are byte-identical |

A codebase of ~400 files and ~1.8 M tokens scans in under 10 s.

## Reading the output

The stats lines say what was compared and what was pruned:

```
Body clones: 4801 bodies signed (2460 under the size floor), 4903 LSH buckets (0 oversize, skipped),
  19299 candidate pairs: 60 nested in each other, 10306 ruled out by size, 8933 verified, 255 accepted -> 129 clusters
Idioms: 1800982 windows hashed, 36128 recur in enough files, 31306 absorbed into a longer run,
  4089 too generic (filtered, listed in the report), 733 reported
```

- *ruled out by size*: two shingle sets whose sizes differ by more than the floor
  cannot reach it, so they are not compared.
- *nested in each other*: a callback is not a copy of the function that contains it.
- *oversize buckets*: an LSH bucket with more than 60 bodies is a family of trivial
  shapes. It is skipped and counted, never silently dropped.

Report sections, in order:

1. **Body clones under different names.** Cross-file clusters first.
2. **Repeated idioms**, each with an excerpt from its first occurrence and every
   location.
3. Body clones with the same name. `duplicate-candidates` lists these too; they are
   here for completeness.
4. **Filtered: generic idioms**, below `--min-info`.

## What to do with a candidate

- **A body clone under several names:** keep the best one in a shared module, point
  every caller at it, and delete the rest. Compare edge cases first (bounds, NaN, a
  cap that can lower a value), because copies drift.
- **A repeated idiom** is usually a missing helper. Name it once
  (`isOpenWater(x, z)`) and replace the copies. Then add a **guard**: a test that
  fails when the raw idiom shows up again outside the helper. That catches the next
  copy when it is written, not in the next audit.
- **Or leave it.** A short, obvious idiom can be cheaper inline than behind a
  helper. Leaving it is a decision, not an omission.

## Known limitations

- **Token-level, not semantic.** A copy that was reordered, or rewritten from `for`
  to `reduce`, is not the same shape and is not found.
- **Idioms need a shared name.** A snippet made only of local variables and
  arithmetic scores 0 bits and is filtered (still listed in the report). Use
  `--min-info 0` to look at those.
- **Adjacent pieces of one pasted block** can show up as two neighbouring idioms
  when the code between them differs. Read them together.
- **Same-file repetition** counts for body clones but not for idioms, which need
  different files. Use `--min-files 2` and a smaller `--window` for a closer look.

## Files

- `find-repeated-code.mjs` — the tool (CLI + exported pure helpers). It reuses the
  tokenizer, function extractor and file walker of `duplicate-candidates`.
- `find-repeated-code.test.mjs` — `node:test` tests over in-memory sources and a
  `mkdtempSync` fixture.
