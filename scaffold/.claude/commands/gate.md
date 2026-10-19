---
description: Run the one gate and record its exit code and evidence.
argument-hint: [cheap|full]
---

Run the project's ONE gate. Do not hand-roll a test command; do not add a second gate.

```bash
bash scripts/gate.sh            # full: cheap + suite (takes the lock)
GATE_TESTS=0 bash scripts/gate.sh   # cheap tier only (takes NO lock)
```

**Quote the exit code exactly:**

| Code | Meaning |
| --- | --- |
| `0` | GREEN — the requested tier ran and passed |
| `1` | RED — the requested tier ran and FAILED (read the raw log) |
| `2` | CHEAP — the cheap tier passed, the expensive tier did **not** run |
| `9` | REFUSED — another run holds the lock. **VOID**: not a failure, not evidence |

Never report `2` as "the gate passed". Fix a red gate forward; never re-run until it
changes. Never pipe the gate through `tail`/`head` — it destroys the failing evidence
and the pipeline's exit status becomes the last command's.

The gate appends one JSON line per run to `.cos/journal.jsonl` (the path is derived
from the git common dir, so a worktree run writes the main tree's journal). The line
carries `runtime=dsh|claude-code`, `tier`, `exit`, `sha`, `lock` and the raw log path.

In your report, quote the raw log's numbers: file/test counts, peak memory, voided
chunks. A gate result without its numbers is a claim, not evidence.
