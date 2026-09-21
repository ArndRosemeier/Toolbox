# Toolbox — project rules

Project-level rules for this repo. They layer on top of the host-global
`~/.dsh/AGENTS.md`; nothing here overrides that file, and a direct instruction from
the owner overrides everything.

## What this repo is

Toolbox is the **upstream source of truth** for portable, dependency-free codebase
analysis tools that other projects copy. The unit of distribution is the whole
`tools/` folder, copied into a target project's root. `tools/README.md` is the
contract that travels with it — the folder's 8 rules plus the 10-step porting
checklist.

## The write boundary (owner directive, 2026-09-21)

**This repository is the only project that work here writes to. Every other project
on this host is READ-ONLY.**

- Do **not** modify, commit, branch, or push in another repo — not even to
  "propagate a fix" or "sync" a downstream copy. That includes `Expert`, `FracVibe`,
  `Campaigner`, and any future consumer.
- Fixes and improvements land **here**, in the canonical copy. A downstream project
  picks them up by copying the current `tools/` folder (or using the code directly),
  and *its* agent does that, in *its* repo.
- **Reading** another project is fine — to check whether a port is current, to
  compare copies, or to understand a target codebase before porting. Read-only means
  read-only, not "read, and then patch".
- Divergence between this copy and a downstream copy is expected and **intentional**.
  A stale downstream copy is never a reason to write to the downstream repo; the
  answer is always "that project copies the current Toolbox".

If a task appears to require writing to another project, **stop and report it**
rather than working around the boundary.

## Working rules for this repo

- **Dependency-free by contract.** Node built-ins only; Node ≥ 24. Never add a
  dependency to a tool, and never `npm install` to make one work.
- **Every tool ships with a test.** `npm test` must stay green. A tool without a test
  is not merged.
- **Read `tools/README.md` before changing or adding a tool** — its rules bind
  anything added to `tools/`.
- **Reports are not committed.** Tool output goes to `/reports/` (git-ignored) or
  stdout.
- **Determinism is a rule, not a nicety** (rule 7). Output must be byte-identical
  across runs over the same tree. Any wall-clock or random stamp is **opt-in and
  caller-supplied**, never a default; comparisons use code-unit `<` / `>`, never
  locale-sensitive ordering. (This repo's first determinism bug — a `new Date()`
  default — is recorded in commit `be8eee0`.)
- **One logical change per commit.** Verify before claiming a pass: quote the test
  counts and exit codes actually observed, not the ones expected.
