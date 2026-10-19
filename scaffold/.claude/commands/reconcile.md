---
description: Reconcile the board, the journal and git before dispatching anything.
---

Reconcile the project's state of record against reality. This is a read-and-fix pass,
not a dispatch.

1. Run the status line:

   ```bash
   node scripts/cos.mjs status --one-line
   ```

2. Run the board reconciler if the project has one:

   ```bash
   bash scripts/board.sh
   ```

3. Check, against the **remote** (never a stale local branch):

   - `git fetch <remote> <branch>` and compare `HEAD` with `<remote>/<branch>`;
   - `git worktree list` — every writer's worktree and branch;
   - `git branch -a` — unlanded and claimed-retired branches;
   - the live agent list, if the harness has one;
   - `.gate-lock/owner` — is the suite running, and is the owner PID alive?
   - orphaned suite/browser processes, if a turn died.

4. Fix the record where it lied: the board, `HANDOFF.md`, a stale session line, a
   retirement claim. Do not fix reality to match the record.

5. Report ONE line: what the record said, what reality said, what you changed. Then
   wait for a request or continue the dispatched slice. Nothing is dispatched before
   this pass.
