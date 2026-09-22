# Toolbox

Portable, dependency-free tools for finding **accumulated cruft in long-lived
codebases**, plus the shared knowledge that comes with them.

Every tool here is deliberately boring: **Node built-ins only, no build step, no
dependencies**, runnable with plain `node`. They are **discovery aids for a human**,
not automated judges — each emits a candidate list with evidence and exits `0`;
deciding what to do with a candidate is a human call.

For the reasoning behind the toolbox's design (and the decisions that must not be
rediscovered), see **`tools/README.md`** — the folder's own contract.

---

## Layout

```
tools/                          the portable toolbox — this is the unit you copy
  README.md                     folder contract + numbered 10-step porting checklist
  duplicate-candidates/         functions sharing a name across files (Type-4 clones)
    README.md
    find-duplicate-candidates.mjs
    find-duplicate-candidates.test.mjs
docs/
  WAY-OF-WORKING.md             how code gets written here (Part 1 portable, Part 2 DSH)
```

`tools/` is kept as a single self-contained folder on purpose: the whole folder is
copied into a target project's root, so every tool keeps resolving paths as
`<repo>/tools/...` (the duplicate finder's `REPO_ROOT` is two levels up from its own
file). Copy the folder; do not copy individual files.

---

## Shared knowledge

Cross-project notes and decisions worth carrying between projects live in `docs/`.

| Doc | What it covers |
| --- | --- |
| [`docs/WAY-OF-WORKING.md`](docs/WAY-OF-WORKING.md) | How code gets written in these projects. **Part 1** — the portable strategy: roles, the loop, the durable artifacts, verification doctrine, the brief. **Part 2** — the concrete DeepSeek Harness mechanics: the clock and the gate, worktrees, subagent and host hygiene. |

---

## Tools

| Tool | Command | What it finds |
| --- | --- | --- |
| `duplicate-candidates` | `node tools/duplicate-candidates/find-duplicate-candidates.mjs --src <dir>` | Function-like declarations sharing an **exact, normalised or near-identical name** across different files — Type-4 clone candidates that `jscpd` (token-based) is structurally blind to. Writes `reports/duplicate-candidates.md`. |

---

## Using a tool in another project

Copy the whole `tools/` directory into the target repo root, then follow the
10-step checklist in `tools/README.md`. In short:

```bash
cp -r ~/projects/Toolbox/tools /path/to/other-project/
cd /path/to/other-project
node --test "tools/**/*.test.mjs"        # must pass before anything else
node tools/duplicate-candidates/find-duplicate-candidates.mjs --src <source-root>
```

Then wire the target project's `package.json` (verbatim from the checklist):

```json
"dup:candidates": "node tools/duplicate-candidates/find-duplicate-candidates.mjs",
"test": "node --test \"tools/**/*.test.mjs\""
```

and add `/reports/` to its `.gitignore`. The **quoted glob is required**; a bare
directory argument does not behave the same on every Node 24 build.

The `dup:candidates` script belongs to the *target* project, not here: the tool
defaults to `<repo>/src`, so a script at this root would point at a `src/` that does
not exist. This repo wires only `npm test`.

**Toolbox is upstream.** Fixes and improvements land **here**, in the canonical copy;
a consumer picks them up by copying the current `tools/` folder. Work in this repo
never writes to a downstream project to sync a copy, so divergence between this copy
and a consumer's copy is expected. The boundary is written down in `AGENTS.md`.

---

## The contract

The full text is in `tools/README.md`. These rules bind anything added to `tools/`:

1. **Dependency-free.** Node built-ins only. No `npm install`, no build step.
2. **Every tool ships with a test.** `npm test` must stay green.
3. **Read-only against project source.** Output goes to `reports/` or stdout.
4. **Pointers, not judges.** Filtered items must be counted, reported, still written
   to the report, and recoverable by a flag — never quietly discarded.
5. **Evidence, not boasts.** Every tool prints its scan stats **and its own pruning
   counters**.
6. **Exit `0` on success.** Finding lots of cruft is success.
7. **Deterministic ordering**, so two runs diff cleanly.
8. **Robust against unparseable input.** A file that cannot be read is skipped and
   counted, never fatal; never follow symlinks out of the repo.

---

## Tests

```bash
npm test
```

No install step: the tools and their tests use Node built-ins only. Node **≥ 24** is
the reference runtime (`node --test`, ESM, `fs.readdirSync(..., { withFileTypes: true })`).
