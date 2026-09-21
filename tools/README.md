# `tools/` — portable, dependency-free codebase analysis

This folder holds small, self-contained tools for finding **accumulated cruft in a
long-lived codebase**: dead code, near-duplicate functions, drift that no compiler
and no linter will ever flag. They are deliberately boring: **Node built-ins only,
no build step, no dependencies**, runnable with plain `node`.

They are **discovery aids for a human**, not automated judges. Each one emits a
candidate list with evidence and exits `0`; deciding what to do with a candidate is
a human call.

Everything here is read-only against project source. Nothing in `tools/` modifies
`src/`.

---

## Rules of this folder

These rules are the contract for anything added to `tools/`. They are the same in
every project this folder is ported to.

1. **Dependency-free.** Node built-ins only (`node:fs`, `node:path`, `node:test`,
   `node:assert`, …). No `npm install`, no build step, no config file. Node 24 is
   the reference runtime.
2. **Every tool ships with a test.** `npm test` must stay green. A tool without a
   test is not merged.
3. **Read-only against `src/`.** A tool may read project source; it may never
   modify it. Output goes to `reports/` (git-ignored) or stdout.
4. **Pointers, not judges.** Every tool says plainly, in its own output, that what
   it emits are *candidates requiring human review*. A name or shape match is
   **not** proof. Over-reporting is acceptable and expected; **silently missing
   things is not**. A tool may filter noise from its default view, but any filtered
   item must be **counted, reported, still written to the report, and recoverable**
   by a flag — never quietly discarded.
5. **Evidence, not boasts.** Every tool prints its scan stats **and its own pruning
   counters** — how many comparisons it actually made, and how many it exited
   early on and why. A tool that claims to prune but compares everything anyway is
   worse than useless.
6. **Exit `0` on success.** Successfully finding lots of cruft is success. Non-zero
   exit only for a real error (bad path, unreadable output, crash).
7. **Deterministic ordering.** Two runs over the same tree produce byte-identical
   output, so reports diff cleanly.
8. **Robust against unparseable input.** A file a tool cannot read or parse is
   skipped and counted — never a crash. Never follow symlinks out of the repo.

---

## Tools

| Tool | Command | What it finds |
| --- | --- | --- |
| `duplicate-candidates` | `npm run dup:candidates` | Function-like declarations that share an **exact, normalised or near-identical name** across different files — Type-4 clone candidates that `jscpd` cannot see. Writes `reports/duplicate-candidates.md`. |

---

## How to port this folder to another project

A concrete checklist. It is written so an agent can follow it on an unfamiliar
repo without reading this project's history first.

1. **Copy the whole `tools/` directory** into the target repo root (keep the
   subfolder layout):
   ```
   tools/
     README.md
     duplicate-candidates/
       find-duplicate-candidates.mjs
       find-duplicate-candidates.test.mjs
       README.md
   ```
2. **Check the runtime.** The tool assumes Node ≥ 24 (`node --test`, ESM,
   `fs.readdirSync(..., { withFileTypes: true })`). It has no other assumptions.
   Do not run `npm install` for it.
3. **Run the tests first**, before wiring anything:
   ```
   node --test "tools/**/*.test.mjs"
   ```
   The tests use a `mkdtempSync` fixture, not the target repo's `src/`, so they
   should pass unchanged and in well under a second.
4. **Wire the package scripts** (keep every existing script):
   ```json
   "dup:candidates": "node tools/duplicate-candidates/find-duplicate-candidates.mjs",
   "test": "node --test \"tools/**/*.test.mjs\""
   ```
   The **quoted glob is required**; a bare directory argument does not behave the
   same on every Node 24 build.
5. **Add the ignore entry** so tool output never lands in a commit:
   ```
   /reports/
   ```
6. **Set the scan root if it is not `src/`.** The tool defaults to `<repo>/src`.
   For a different layout, pass the root explicitly:
   ```
   node tools/duplicate-candidates/find-duplicate-candidates.mjs --src app
   ```
   and put that flag in the `dup:candidates` script.
7. **Run the tool.** Exit code must be `0` even with candidates:
   ```
   npm run dup:candidates
   ```
8. **Expect noise — that is the design.** A large real codebase will produce
   thousands of exact-name pairs (every `render()`, `constructor()`, `initialize()`
   matches). Sort by the `sim` hint and read the top of each tier; use
   `--max N` if you want the whole list on stdout rather than in the report.
9. **Do not treat the output as a work list on day one.** It is a map of where to
   look. Confirm each candidate by opening both functions (see the tool README).
10. **Keep it in sync.** If you change the tool, run `npm test` and re-run the
    tool; commit the tool and its test together.

### Caveats when porting

- **Different source layout.** Monorepos often have several source roots
  (`packages/*/src`). The tool currently scans one root; run it per package
  (`--src packages/a/src --report reports/dup-a.md`) or extend `scanTree` with a
  list of roots. Do not silently scan `node_modules`.
- **Generated, vendored and minified files.** The walker skips `node_modules` and
  any `dist*` directory, but it cannot know that `src/generated/schema.ts` is
  machine-written. Exclude those roots or expect inflated counts.
- **Non-`.ts` sources.** The extractor is tuned for TypeScript (`.ts`), and
  deliberately skips `.d.ts`, `*.test.ts` and `*.spec.ts`. For a JS repo, adjust
  the extension filter in `scanTree`. For **JSX/Vue/Svelte** files the tokenizer
  will not understand template/markup blocks — those need a real extractor (or a
  pre-pass that pulls out the `<script>` block) before this tool is meaningful.
- **Decorators and exotic syntax.** The brace/paren matching is heuristic. A file
  that defeats it is skipped and counted, never fatal, but a heavily decorated
  codebase may lose a few functions. Check the skipped count in the stats line.
- **Ordering stability.** Reports are ordered by similarity, then name, then
  file/line, so they are diffable. If you change a threshold, expect that diff.

---

## Reports

Tool output lands in `reports/` (git-ignored). The directory is created on demand.
The markdown report is the durable artifact; stdout is the quick look (per-tier
lists are capped by default, with the full list always in the report).
