---
description: Write the one-screen handoff that lets the next session (either harness) continue.
---

Write `HANDOFF.md` before you stop. It is the baton, not a memory dump: one screen,
overwritten in place.

1. Draft the factual fields:

   ```bash
   node scripts/cos.mjs handoff
   ```

2. Fill the judgment fields yourself — the draft's `<fill>` markers are not a handoff:

   - **by** — harness and session id (the draft detects them);
   - **at** — ISO timestamp;
   - **branch / worktree** — where the work is, absolute;
   - **last verified** — sha, gate exit code, counts;
   - **done** — what actually landed since the last handoff, one line each;
   - **in flight** — writers, probes, branches, unlanded work;
   - **next action (one)** — the single next step a successor should take;
   - **open questions for the owner** — only decisions that are genuinely the owner's;
   - **read first** — the two or three files that carry the context.

3. Overwrite `HANDOFF.md`, then commit it with the landing (or as the only change if
   the session is stopping between slices). A handoff that is not committed does not
   exist.

4. If the next action is a dispatch, say which role (`writer`, `reviewer`, `probe`)
   and which worktree. Do not leave "continue the work" as the next action.

The next session — in DSH or Claude Code — reads `AGENTS.md`, then
`docs/CROSS-TOOL.md`, then this file. It must be able to act within minutes.
