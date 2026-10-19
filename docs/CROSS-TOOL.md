# The cross-tool contract — one project, two harnesses

This project is worked from **two harnesses**: the DeepSeek Harness (DSH) and
Claude Code. The owner may start work in one and continue it in the other. This
document is the contract that makes that possible.

## The line

**Transcript resume is not available, and is not the target.** DSH stores
`session.v3.jsonl.zstd`; Claude Code stores its own `<uuid>.jsonl`. Neither reads the
other's format, and neither exports to it. Do not build a bidirectional converter.

**Work resume is the target.** The workspace is the session: the same repo, the same
rules, the same gate, the same journal, and a handoff note. A fresh session in either
harness can pick up the baton from disk.

Three artifacts carry the work across:

| Artifact | Answers | Lifetime |
| --- | --- | --- |
| `HANDOFF.md` | *What is the baton right now?* | overwritten at every stop |
| `.cos/journal.jsonl` | *What actually ran?* | append-only, local |
| `docs/BOARD.md` | *What is happening in this project?* | current state only |

`HANDOFF.md` is not a memory system. It is one screen, overwritten in place, because
the next session — in either harness — must be able to act from it in minutes.

## What is shared, and what is not

| Machinery | DSH | Claude Code | Contract |
| --- | --- | --- | --- |
| `CLAUDE.md` or `AGENTS.md` | loaded (both candidates) | loaded (both) | **one shared law; never two different files** |
| `.claude/commands/*.md` | `node scripts/cos.mjs run <name>` | `/name` | **shared procedures** (optional) |
| `.claude/agents/*.md` | `node scripts/cos.mjs dispatch <name>` | subagent definition | **shared role prompts** (optional) |
| Claude Code hooks | bridge (profile-level) | native `.claude/settings.json` | **shared hook layer** |
| `scripts/gate.sh` | runs it | runs it | **one gate; journal append** |
| `scripts/cos.mjs` | runs it | runs it | **shared loader + record tool** |
| `.cos/journal.jsonl` | writes/reads | writes/reads | **shared history** |
| `HANDOFF.md` | reads/writes | reads/writes | **shared baton** |
| `.claude/skills/` | not scanned | native | **not shared** (use commands/agents) |
| `.claude/rules/` | not loaded | native | **not shared** (put rules in the instruction file) |
| `.mcp.json` | profile YAML only | native | **host-level port, not per project** |
| `settings.permissions` | DSH sandbox/approval | native | **not shared** |
| session `--resume` | own format | own format | **not shared** |

## The session protocol

### Start (either harness)

1. Read the project's instruction file — `CLAUDE.md` or `AGENTS.md`, whichever it
   uses; both harnesses read both — then `docs/CROSS-TOOL.md` (this file), then
   `HANDOFF.md` (the baton).
2. If you are the chief of staff, read `docs/BOARD.md` and the ledger row you are
   about to extend.
3. Run `node scripts/cos.mjs status --one-line`, then check it against reality:
   the **remote** branch (never a stale local one), `git worktree list`, the live
   agent list, and the gate lock. Fix the record where it lied; report one line.
4. Do not dispatch anything before that pass.

### During

- **One gate:** `bash scripts/gate.sh`. It appends one JSON line per run to
  `.cos/journal.jsonl`, with `runtime=dsh|claude-code`. Never hand-roll a test
  command; never pipe the gate through `tail`/`head`.
- **Writers:** at most two, each in its own worktree, each with absolute paths in the
  brief. The role prompt is `.claude/agents/writer.md`.
- **The worktree guard:** before dispatching, record each writer's worktree with
  `node scripts/cos.mjs worktree add <absolute path>`. The `PreToolUse` hook denies
  writes outside those roots for child sessions; the dispatcher's own session is
  spared. Remove the root when the writer retires (`worktree remove`), or
  `worktree clear` when none remain.
- **The dispatcher keeps the verdict.** The gate supplies evidence; a test passing is
  not the same as the owner's intent being served. Never automate "verified".

### Stop (either harness)

1. Run the gate tier the change asks for. Quote its exit code exactly (`0` green,
   `1` red, `2` cheap only, `9` refused/VOID).
2. Overwrite `HANDOFF.md` from the template: by, at, branch/worktree, last verified
   sha + gate, done, in flight, **next action (one)**, open questions, read first.
3. Commit `HANDOFF.md` with the landing. A handoff that is not committed does not
   exist.
4. If you are the chief of staff, update the board in the same commit.

## The designation prompt

Use this when you make an agent chief of staff. The short form is enough **once the
project is scaffolded**; the long form is for the first session.

### Short form (project already has the contract)

```
Be my chief of staff for this project. Read the project's instruction file
(AGENTS.md or CLAUDE.md), then docs/CROSS-TOOL.md, then HANDOFF.md. Run
`node scripts/cos.mjs status --one-line`, reconcile it against the remote, the
worktrees and the gate lock, and report one line before dispatching anything.
Then follow docs/CROSS-TOOL.md.
```

### Long form (first session, or a project that needs the scaffold)

```
You are my chief of staff for <project>. This project is worked from both DSH and
Claude Code; the contract is docs/CROSS-TOOL.md. Before anything else:

1. Read the project's instruction file (AGENTS.md or CLAUDE.md), then
   docs/CROSS-TOOL.md, then HANDOFF.md.
2. Run `node scripts/cos.mjs status --one-line`. Check it against the REMOTE
   branch, `git worktree list`, the live agent list and the gate lock. Fix the
   record where it lied; report ONE line; only then dispatch.
3. One gate: `bash scripts/gate.sh`. Quote its exit code exactly; never pipe it
   through tail/head. The gate appends to .cos/journal.jsonl.
4. At most two writers in flight, each in its own worktree, each briefed with
   absolute paths. Verify every landing yourself before retiring it.
5. Keep the record true BEFORE you report: update HANDOFF.md and the board in the
   same commit as the landing.
6. Report short: what landed, sha, gate exit and counts, what is blocked, what you
   need from me.

If this project has no docs/CROSS-TOOL.md yet, stop and say so. A greenfield
project needs the Toolbox scaffold; an existing Claude Code-native project needs
minimal adoption (see Installation). Never create a second instruction file.
```

### The trigger is enough

**"Be my chief of staff" is the designation.** In DSH the host rule points here; in
Claude Code the user-level memory (`~/.claude/CLAUDE.md`) does. On a project that has
this contract, the agent reads the instruction file, this doc and `HANDOFF.md`, runs
the status line, reconciles, and works.

On a project that has **no** contract, the agent reports the gap in one line and offers
the one-step fix: the Toolbox scaffold for a greenfield project, minimal adoption for
an existing Claude Code-native project. It does not rewrite an existing repo without
your word, and it does not invent the stack or the gate commands. To pre-authorize,
add **"and adopt it"** (or **"and scaffold it"**) to the designation.

The two forms above remain useful when you want the procedure spelled out, or when the
agent is running somewhere the trigger is not installed.

## Installation

A **greenfield** project copies the Toolbox scaffold (`cos init`). An **existing
Claude Code-native** project adopts minimally (below) — it must not be given a second
instruction file or a Toolbox-shaped board it did not ask for. The hook layer is
installed **once per host**, because both harnesses read the same user-level settings
file:

- `~/.claude/settings.json` holds the three generic hooks; Claude Code reads it
  natively, and DSH's `@deepseek-ai/dsh-hooks-claude-code` bridge is pointed at the
  same path.
- The hook commands call one dispatcher, which runs
  `<project>/.cos/hooks/<event>.sh` when that file exists and exits 0 otherwise. A
  project without the contract is unaffected.
- DSH's bridge is mounted at the profile level; it is process-wide and read once at
  startup. **Project-level `.claude/settings.json` hooks do not load in DSH** — only
  the user-level file does. That is why the generic hooks live there.

The bridge is a compatibility layer, not a security boundary: it **fails open** (an
unreadable config or a crashed hook runs no hook and the agent continues), and its
`stop_hook_active` is always `false`. Write self-limiting hooks; never rely on the
bridge as the only guard.

### Minimal adoption for an existing Claude Code-native project

A project may already have a working Claude Code flow: a thin `CLAUDE.md`, a seam
index in `docs/`, deterministic guards in its test command, a PR + change-note +
changelog-bot cadence. Do **not** run `cos init` on it — that would add a second
instruction file and a board/ledger it did not ask for (`cos init` refuses when
`CLAUDE.md` exists). Add only the baton and the event journal:

1. `HANDOFF.md` — copy the template.
2. `scripts/gate.sh` — copy it; set `GATE_CHEAP_CMD` / `GATE_FULL_CMD` to the
   project's own commands (for example `npm run typecheck` / `npm test`). It
   journals every run; it does not replace the project's checks.
3. `scripts/cos.mjs` + `scripts/cos-hook.mjs` — copy them.
4. `.cos/hooks/*.sh` — copy them; they no-op without state.
5. A few lines in the existing instruction file: read `docs/CROSS-TOOL.md` and
   `HANDOFF.md`; run the gate; update the handoff before stopping.
6. `.claude/commands/` and `.claude/agents/` — optional; add only if the project
   wants those procedures.

The project's own landing protocol wins: PRs, change notes, the changelog bot, the
seam index, whatever it already has. `docs/BOARD.md` and `docs/DECISION-LEDGER.md`
are not required for a project whose record already lives elsewhere.

### Harness mechanics stay separate

The project's instruction file is the shared law. The mechanics that make it work are
not:

- **DSH:** one frozen goal, paused; a subagent's background jobs die with its turn;
  the dispatcher's expensive gate runs as a background job in a persisting session.
- **Claude Code:** no goal tools; background tasks are the Task tool's; permissions
  are its own.

Do not encode one harness's mechanics as universal law. The shared file says what is
true in both; each harness's own docs say how.

## The round-trip proof

The contract is installed when this passes on a throwaway project:

1. DSH: run the chief-of-staff command, dispatch a writer, run the gate, write
   `HANDOFF.md`, commit.
2. Claude Code: read the instruction file and `HANDOFF.md`, run the same command
   natively (if the project has one), run the same gate, continue the work, write
   `HANDOFF.md`, commit.
3. Verify: both sessions saw the same instruction file; the same command/agent bodies
   (or the project's own flow); the hooks fired in both; `.cos/journal.jsonl` holds one
   run with `runtime=dsh` and one with `runtime=claude-code`; the second session could
   state the next action from `HANDOFF.md` without re-reading the code.

If the proof fails, fix the contract — not the session.
