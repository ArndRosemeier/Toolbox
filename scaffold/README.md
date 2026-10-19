# `scaffold/` — the day-1 files that are not documents

The process documentation lives in [`../docs/`](../docs/README.md). This folder holds
the copy-ready files that are **not** documents: the project-rules template, the two
scripts that implement the [gate](../docs/GATE.md) and the board's reconciler, and the
cross-tool contract's Claude Code and DSH files.

Copy them into a new repo **before writing feature code**. The full day-1 list —
documents included — is in [`../docs/README.md`](../docs/README.md).

## Fast path: `cos init`

From the Toolbox repo:

```bash
node scaffold/scripts/cos.mjs init /path/to/new-project
```

It copies the scaffold, renames the templates, creates `.cos/` and `docs/`, rewrites
the scaffold-relative links in the copied docs, and appends the `.gitignore` entries.
It does not run `git init` and does not overwrite an existing `AGENTS.md` unless you
pass `--force`.

## The files

| Copy | To | Then |
| --- | --- | --- |
| `AGENTS.md.template` | `<repo>/AGENTS.md` | fill the stack line; keep every rule |
| `HANDOFF.md.template` | `<repo>/HANDOFF.md` | keep it one screen; overwrite at every stop |
| `.claude/commands/*.md` | `<repo>/.claude/commands/` | the procedures (`/reconcile`, `/handoff`, …) |
| `.claude/agents/*.md` | `<repo>/.claude/agents/` | the role prompts (writer, reviewer, probe) |
| `.cos/hooks/*.sh` | `<repo>/.cos/hooks/` | the project-side hook logic; no-ops without state |
| `scripts/gate.sh` | `<repo>/scripts/gate.sh` | set `GATE_CHEAP_CMD` / `GATE_FULL_CMD`; `chmod +x` |
| `scripts/board.sh` | `<repo>/scripts/board.sh` | set `BOARD_FILE` / remote / branch; `chmod +x` |
| `scripts/cos.mjs` | `<repo>/scripts/cos.mjs` | the loader: `run`, `dispatch`, `status`, `handoff`, `doctor` |
| `scripts/cos-hook.mjs` | `<repo>/scripts/cos-hook.mjs` | the hook logic behind `.cos/hooks/*.sh` |

And the documents, out of `../docs/`:

| Copy | To |
| --- | --- |
| `docs/BOARD.md` | `<repo>/docs/BOARD.md` |
| `docs/DECISION-LEDGER.md` | `<repo>/docs/DECISION-LEDGER.md` |
| `docs/SEAM-INDEX.md` | `<repo>/docs/ARCHITECTURE.md` |
| `docs/TESTING.md` | `<repo>/docs/TESTING.md` |
| `docs/BRIEF.md` | `<repo>/docs/BRIEF.md` |
| `docs/GATE.md` | `<repo>/docs/GATE.md` |
| `docs/CROSS-TOOL.md` | `<repo>/docs/CROSS-TOOL.md` |
| `docs/TRAPS.md` | `<repo>/docs/TRAPS.md` |
| `docs/WAY-OF-WORKING.md` | `<repo>/docs/WAY-OF-WORKING.md` |

The `.template` suffix on the project-rules and handoff files is deliberate: an
`AGENTS.md` in this repo would be auto-loaded as binding instructions for the
`scaffold/` subtree, which a template must never be. Rename it on copy.

## Install the hook layer once per host

Both harnesses read the same user-level file:

- `~/.claude/settings.json` holds the three generic hooks; Claude Code reads it
  natively, and DSH's `@deepseek-ai/dsh-hooks-claude-code` bridge is pointed at it.
- The hooks call one dispatcher, which runs `<project>/.cos/hooks/<event>.sh` when it
  exists and exits 0 otherwise. A project without the contract is unaffected.
- DSH's bridge is process-wide and read once at startup: project-level
  `.claude/settings.json` hooks do not load in DSH. That is why the generic hooks
  live in the user-level file.

The bridge is a compatibility layer, not a security boundary: it fails open, and its
`stop_hook_active` is always false. The hooks are self-limiting.

## Add to the project's `.gitignore`

```
/.gate-logs/
/.gate-lock/
/worktrees/
/.cos/journal.jsonl
/.cos/worktrees
/.cos/root-session
/.cos/.stop-guard
```

The journal is local history; `HANDOFF.md` and the board are the committed record.

## The acceptance test for day 1

The scaffold is installed when all of these hold:

```bash
node scripts/cos.mjs doctor            # → no FAIL
node scripts/cos.mjs status --one-line # → one line
bash scripts/board.sh                  # → BOARD RECONCILED (after a push)
GATE_TESTS=0 bash scripts/gate.sh; echo $?   # → 2  (cheap tier green, suite NOT run)
```

`2` is the correct answer here, not a failure: it means the cheap tier passed and
the expensive tier did not run. It must never be quoted as "the gate passed".

`board.sh` reconciles against the **remote** branch, so push once before expecting
`BOARD RECONCILED`. With no remote it says `CANNOT LOOK` and exits 1 — loudly, which
is the correct behaviour for a check that cannot see reality.

## Add the rest when you meet the failure

The full process has more mechanics — probes, differential verification, worktree
recipes, host ceilings. **Do not build them all on day 1.** Each was added after a
specific failure; add it when you meet that failure. What must exist on day 1 is the
board, the decision ledger, one gate command, a brief template and the cross-tool
contract, because everything else presupposes them.

## If the project already has equivalents, they win

This scaffold is a starting point. A project's own `AGENTS.md` and docs are the
authority for its mechanics — adapt these files rather than overriding a project's
existing, better-informed rules.
