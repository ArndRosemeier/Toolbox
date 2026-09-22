# The way we work — orchestrated, verified, disposable

**What this is.** How code gets written in these projects. A human supplies intent
and decisions; **one** agent acts as **chief of staff** (scope → brief → dispatch →
verify → retire → report); short-lived **writer** agents each deliver one verified
slice from their own worktree; and every piece of state that matters lives on disk,
so the coordinating session is disposable.

It is written in two parts on purpose:

- **Part 1 — the ideas and the strategy.** Portable: any project, any agent
  harness. Nothing here depends on a specific tool.
- **Part 2 — how we run it on the DeepSeek Harness (DSH).** Concrete: the actual
  tools, paths, limits and gotchas of this environment.

**Provenance.** The reference implementation is the **Campaigner** project
(`~/projects/Campaigner`). Its `docs/22-DEVELOPMENT-PROCESS.md` is the portable form
that Part 1 distills; `docs/20-ORCHESTRATION.md` is a live board; its `AGENTS.md`
carries the detailed parallel-writer, worktree, host-hygiene and gate rules that
Part 2 draws on. If a project has its own equivalents, **they win** — this document
is a starting point, not an override.

**A rule of this document, inherited from its sources:** every rule below exists
because its absence cost something real, so where a rule has an incident, the
incident is named. A rule whose reason is lost gets deleted by the next person in a
hurry, and the incident comes back.

---

# Part 1 — The ideas and the strategy

## 1 · The shape, in one page

```
            intent, decisions, acceptance
   owner ────────────────────────────────────────────┐
     ▲                                               ▼
     │ report (short, numbers, honest)        ┌───────────────┐
     │                                       │  DISPATCHER   │  intake → scope → brief
     │                                       │ (chief of staff)│ dispatch → verify → retire
     │                                       └───┬───────┬───┘
     │            landing (commit+push+report)   │       │  scoping answer (no writes)
     │        ┌──────────────────────────────────┘       └───────────────┐
     │        ▼                                                          ▼
     │   WRITERS (≤2 in flight)                                  PROBES (read-only, parallel)
     │   one slice each, own worktree                            "what does the code actually do?"
     │        │
     └────────┴──► DURABLE STATE (survives any death):
                   decision ledger · seam index · board · git branches/worktrees
```

## 2 · Three premises

Everything else follows from these. They are stated first because a reader who
rejects one will find the rest arbitrary.

1. **The agent's context is the scarce resource, not its intelligence.** Every
   mechanic exists to keep knowledge *out* of the conversation and *in* files.
2. **A handover must be possible in minutes.** Assume the session can die at any
   moment, because it has. A predecessor session died of a compaction failure with a
   35 MB log.
3. **Work is only done when it is verified by someone other than its author.** A
   writer's own gate proves the change does what the writer *meant*; it cannot
   answer "is it right?".

## 3 · Roles

| Role | Who | Owns |
|---|---|---|
| **Owner** | the human | intent, priorities, taste, product decisions, acceptance. Never asked to debug; asked to choose between named options. |
| **Dispatcher / chief of staff** | one long-lived agent session | intake (extract the intent behind the literal ask), scoping, the brief, dispatch, **independent verification of every landing**, retiring branches/sessions, the board, the report. |
| **Writer** | a short-lived agent, one per slice | ONE coherent change: code + tests + docs + its own gate + its own differential, committed on its own branch, then a short landing report. |
| **Probe** | a read-only agent | answering one scoping question from the code ("where is X rendered, and what context does each surface have?"). Writes nothing. Its report becomes a brief. |

**Why separate the dispatcher from the writers.** A writer that also plans burns its
context on the plan and rushes the change; a dispatcher that also writes stops being
able to verify anything. The separation is not ceremony — it is the only mechanism
that produces independent verification without a second human.

**Two writers maximum**, because every writer can start a full test suite and the
machine is shared — see Part 2 §7.

## 4 · The loop

Per slice:

**intake** (restate the intent behind the literal ask) → **scope** against the
project's own architecture/process docs (probe first if the answer is not obvious)
→ **brief** (intent, the ONE seam it extends, the worktree, the gate, the pins, the
cadence contract, and "commit the coherent partial state or report BLOCKED") →
**dispatch** (≤2 writers, each in its own worktree, absolute paths) → **verify every
landing yourself** → **retire** (session, worktree AND branch) → **update the record
in the same commit as the landing** → **report**.

**The dispatcher does not implement large changes while a writer can.** The
dispatcher verifies.

## 5 · The durable artifacts

Everything the process knows lives in four files plus git. Build this shape before
writing any feature code.

| Artifact | Answers | Rule |
|---|---|---|
| **Decision ledger** | *Why is it like this?* — one row per decision, quoting the owner verbatim, with the evidence, what was rejected, and what is unproven. | **Append-only.** A decision is history; history never rots. Never edit another landing's row. |
| **Seam index** | *How does the code work, and where is the ONE way to do X?* — layer map, seam rows, gotchas, known debt. | A landing that adds, moves or deletes a seam updates its row **in the same commit**. Index entries describe the present, so they are **checkable**, never prose. |
| **Board** | *What is happening right now?* — in-flight writers, unlanded branches, the queue, traps. | **One screen, overwritten in place.** A record that no longer describes the present belongs in the ledger or nowhere. |
| **Testing doc** | *What proves this, and what was actually run?* — the matrix, the pins, the differential arms with their hashes, the VOID probes. | Grows a section per landing; the raw gate log is kept until the landing is verified. |

**The insight these four encode:** docs that *restate behaviour* rot; docs that
*record decisions* do not. So behaviour lives in a test (the test **is** the
statement), and the doc holds the pointer and the reason.

## 6 · The board is checked, never believed

Prose about state rots, so the board is reconciled against reality by a script
before anything is dispatched. The reconciler compares every claim against the
world: does each landed sha exist on the **remote**; is a claimed in-flight writer
still a live session in the harness registry; does a branch claimed as retired still
exist; is the suite lock held, and by whom; is a record missing that git knows
about.

**Rules that make the board trustworthy:**

1. **Updated in the same commit as the landing it records.**
2. **True BEFORE the dispatcher reports the landing to the owner.** If the session
   dies the second after that report, a successor must be able to act from the
   record and git alone.
3. **Every record names something checkable** — sha, branch, worktree, session id,
   path. "Probably fine" is not a record.
4. **Session start = reconcile first.** Read the record, run the reconciler, compare
   with the live agent registry and the host, fix what lied, report ONE line, then
   wait for a request. Nothing is dispatched before that pass.
5. **Reconcile against the REMOTE branch, never a stale local one.** A landing once
   read as "unlanded" for hours while it was pushed and five commits ahead of a stale
   local branch.

Records are one line each, with stable prefixes and `field=value` pairs, so a query
is a `grep` and the answer is a line, not a paragraph. Vocabulary worth reusing:
`reconciled` · `SESSION` · `PROBE` · `IN-FLIGHT` · `LANDED` · `QUEUE` ·
`QUEUE-CLOSED` · `TRAP` · `GUARD` · `RECOVERY`.

## 7 · The rules that carry the weight

### 7.1 Engineering rules

1. **No silent fallbacks.** When data, parsing or a step fails, propagate a LOUD
   error. Forbidden: finalizing an artifact from an empty or failed draft,
   `catch`-and-continue around parsing, logging an error with no user surface,
   placeholder values standing in for required data. Defaults are allowed only for
   genuine user preference or optional enrichment — never to mask a failure.
2. **Errors must be visible**, through the app's one error surface.
3. **Validate at every boundary.** Machine output is parsed with a schema; a
   validation failure fails the step. It never becomes empty data.
4. **Centralize, and keep it simple.** When one idea is implemented in more than one
   place, make it ONE seam and route callers through it. When you touch an
   already-distributed pattern, folding it is part of the change — unless that is
   genuinely more expensive than the defect, in which case say so in writing where
   the next reader will hit it.

### 7.2 Critique the instruction

**The human's instruction is INTENT, not design.**

1. Extract the intent first — the felt problem behind the literal ask.
2. If the requested mechanism is wrong, fragile, or more expensive than the goal,
   say so plainly and offer the better route, briefly.
3. **Do not silently substitute.** A different design may replace the asked-for one
   only when it serves the SAME intent *and* the owner has been told. The owner must
   always be able to see which decisions were theirs.
4. Judge the friction: minor imperfections get decided in one line, not debated.
5. Route the critique **through reality, not taste**: "this breaks X, here is the
   code that proves it" is a critique; "this feels off" is not.
6. **Briefs are bound by this too.** Every brief tells the writer to report BLOCKED —
   with evidence — rather than implement something it can prove is wrong, *including
   when the flaw is in the brief's own design*.
7. The decision stays the owner's. Present the better way once; if the owner
   reaffirms, execute it well and stop re-arguing.

### 7.3 Centralization, made mechanical

Duplication is invisible when a copy is BORN: nothing fails, and each copy is correct
where it was written. So it is caught by **pins**, not by discipline. Four
obligations:

1. **A brief names the seam it extends.** Before dispatching, find how the repo
   already does the thing and name that ONE seam. A writer that finds a SECOND
   mechanism reports it instead of quietly adding a third.
2. **A centralization lands with an "exactly one" pin** — a test that goes red when a
   second implementation appears. Never centralize by prose alone.
3. **An index entry is checkable; a decision is history** (§5).
4. **A cross-cutting discovery starts with the seam question, and the answer is
   WRITTEN DOWN.** Every brief and every landing report carries one greppable line:
   `COPIES: n→1 — <the seam that now carries it>` when copies were folded, or
   `COPIES: 1 — checked, no duplication (grepped: <what>)` when the change is
   genuinely single-site. A brief without it is incomplete; a landing without it is
   not verified.

The real case this exists for: **seven identical helpers**, one per adapter, that no
test could see until a task happened to grep the right word. A generic detector now
parses every named function body, normalizes it (comments stripped, formatting
collapsed, the function's and parameters' own names blanked so a rename cannot hide a
copy), and requires each multi-site population to equal a checked-in inventory
exactly. A new copy reds naming every site; a folded copy reds as a **stale** entry
until its line is deleted — so a blessing cannot outlive the duplication. It is a
**tripwire, not a proof** (it cannot see paraphrases or bodies under its measured
floor), which is why obligation 2's per-idea pin still closes each fold.

## 8 · Delegation mechanics

**Separate worktrees, always.** Two writers in one tree share one git index, and
`git commit` commits the whole index — file disjointness does **not** protect the
commit phase. A real purge commit once swept a concurrent writer's staged feature
work under the wrong subject. One worktree per writer.

**Absolute paths, stated twice in every brief.** Every shell call runs in a fresh
shell whose working directory is the session workspace, and file tools resolve
relative paths against that same workspace — so a writer told to work in a worktree
edits the MAIN tree unless every path is absolute. Real incident: a writer's six-file
slice landed in the main tree while its own worktree sat clean and commitless, and
the other writer's gates kept failing on half-finished foreign files.

**File disjointness holds for source files and CANNOT hold for the docs.** Every
landing amends the ledger and usually the seam index, so two concurrent writers WILL
conflict there:

- The **dispatcher assigns the ledger row number in every brief**, read at brief
  time, so two briefs cannot claim the same one. (Two writers once both numbered a
  row the same and wrote that number into their docs, code comments and tests.)
- A writer that still hits a docs conflict resolves it as a **mechanical union**,
  renumbers its OWN row only, touches nothing of the other landing, proves that with
  `git diff --name-only`, re-gates on the rebased tree, and pushes.
- **A conflict anywhere else means the disjointness check missed something: STOP and
  report**, do not resolve it.

**Rebase before every push.** Where `main` deploys, `main` is not a staging area: a
red or half-finished landing is user-visible within minutes.

**Cadence contract.** A brief says: report on LANDING or BLOCKED, nothing in between.
The dispatcher waits in silence; a mid-flight nudge is a last resort for real
stagnation. A clean tree with no new commit while the writer is running is **normal**
for a deep-verify phase.

**A writer that cannot finish must COMMIT the coherent partial state on its branch
and report BLOCKED.** Uncommitted work dies with the session. Real incident, twice in
one day: writers failed with empty reports — the one that had committed survived; the
other survived only because its worktree still existed.

## 9 · Verification doctrine

**The dispatcher verifies every landing itself, before retiring anything.** The
writer's word is a claim; the following is the check:

1. **The sha is on the REMOTE** — not the branch, not the local tree.
2. **The dispatcher's OWN gate**, raw log kept, with the summed counts and the peak
   quoted in the record.
3. **The dispatcher's OWN differential** — at least one injection the writer did not
   run — with every arm's file hash PRINTED, the lock held before injecting, and the
   restore done from HEAD by a `trap`. Three failure modes, each seen for real:
   - **Two arms with identical output are a VOID probe**, never evidence against the
     landing (the mutation did not change what ran). Identical arms are the TELL, not
     the result.
   - **A green arm whose mutation certainly changed behaviour is a WRONG-FILE or
     missing-pin signal FIRST**, not a passing test. Grep for the pin's own file and
     run THAT.
   - **Restore from HEAD only the bytes HEAD actually holds.** In a writer's tree
     mid-slice the change is *uncommitted*, and restoring from HEAD WIPES it. Say in
     the brief either "commit first, then inject" or "restore from an out-of-tree
     copy".
4. **The docs were amended in the same commit** (ledger row, seam index, testing doc).
5. **Retire**: delete the session, remove the worktree, delete the branch.
6. **A recovered or silent writer's branch is verified as a FRESH landing** — a dead
   writer's commit has never been gated by a live report.

Also: **fetch and fast-forward before verifying.** A verification run against a stale
local branch anchors nothing; if noticed in time, kill it — none of its numbers may
be used.

## 10 · The brief (copy this)

A brief is self-contained: the writer never sees the conversation.

```markdown
You are a WRITER on <project> (<stack, one line>). Read `<AGENTS.md>` FIRST — the
binding rules. Then read the specs and ledger rows for this area.

# Where you work (READ THIS TWICE)
Your worktree is <ABSOLUTE path> on branch <branch>, based on origin/main = <sha>.
Every bash call runs in a fresh shell whose cwd is the MAIN repo, and file tools
resolve RELATIVE paths against it — so EVERY read/edit/write/bash call MUST use an
ABSOLUTE path under <worktree>. Never touch the main tree. N other writer(s) may be
in flight; your files are disjoint.

# Your ledger row: <N>
A DOCS conflict is a mechanical UNION (renumber YOUR row only); a NON-docs conflict:
STOP and report.

# The owner's report (verbatim) and the intent
"<paste the owner's words exactly>" — then: what outcome the request is reaching for,
and the MEASURED state of the code today (file:line).

# What to build
One numbered list. Name the ONE seam it extends. State the design decisions already
made and that the writer may prove wrong. Name what is deliberately OUT of scope.

# Pins
The behaviours that must go red when broken, each phrased as a statement. Reuse the
existing test harnesses; never build a second fixture set.

# Verification (yours)
1. The ONE gate command; keep the RAW log. Lock busy → WAIT and retry, never reap
   another actor's processes.
2. Your own differential with every arm's file hash printed; lock held before
   injecting; restore from HEAD in a trap. Identical arms are VOID.
3. Commit style; rebase before push.
4. If you cannot finish, COMMIT the coherent partial state and report BLOCKED.

# Docs to amend in the SAME commit
<ledger row N, seam index, testing doc> — and carry the `COPIES:` line.

# Your report (short)
LANDED or BLOCKED, then: sha; gate counts + peak; each arm with its printed hash and
observed failures; the COPIES line; judgement calls; docs amended; and anything this
brief got wrong. Report NOTHING in between. If you can PROVE a rule here is wrong
(including this brief's own design), report BLOCKED with the evidence.
```

Two clauses do the most work: **"the brief may be wrong — prove it and report
BLOCKED"** (it has caught incorrect dispatcher designs) and **"silence until LANDED or
BLOCKED"** (it stops the report-churn that burns a writer's context).

## 11 · Reports

**Writer → dispatcher:** LANDED or BLOCKED; sha; gate as summed counts + peak; each
differential arm with its printed hash and what went red; the `COPIES:` line; how the
deliverable actually works; judgement calls; docs amended; **and every way the brief
was wrong**. Honest correction is a successful report, not a failure.

**Dispatcher → owner:** short, numeric, and first-person about its own verification —
what landed, its own gate numbers, the arms it ran, what it found that the writer did
not, what it got wrong, and the queue. **Evidence goes into docs, never into the
chat.**

## 12 · Insights

1. **Externalize state or die of context.** The answer to a huge context is not a
   bigger context — it is a small thread plus a board, a ledger and git. Rule of
   thumb: quote numbers, never paste logs.
2. **The board is prose and must be checked.** Every reconciliation failure so far has
   been the board lying, never the code.
3. **Verification must be independent to be worth anything.** Both gates are needed:
   the writer's proves intent, the dispatcher's injection proves the pins hold.
4. **A test's NAME is part of the deliverable.** A pin that reds must say what it
   protects.
5. **An injection that does not change bytes proves nothing** (VOID), and a mutation
   that changes bytes but stays green means the pin is missing or the wrong file ran.
6. **Rules must carry their incident**, or they get deleted by the next busy agent.
7. **Intent over literalism.** The best landings started with "the mechanism you asked
   for cannot serve the intent; here is the better route".
8. **Running looks like idling.** A writer in a deep-verify phase has a clean tree and
   no new commit. Never nudge, never kill a running writer.
9. **Work is only finished when it is retired.** An unretired finished writer is how a
   stale list becomes a wrong decision.
10. **Delegation scales the conversation, not the machine.** Probes are cheap and
    parallel because they write nothing; writers are expensive and capped.
11. **One slice, one idea, one seam.** A brief that bundles two ideas produces a
    landing that can only be verified half-way.
12. **Docs split by time-sensitivity**: decisions (never rot) · seams (checkable,
    updated in the same commit) · state (one screen, reconciled) · behaviour (the test
    is the statement).

## 13 · Anti-patterns

| Anti-pattern | What it looks like | The fix |
|---|---|---|
| **Green by wrong file** | an injected arm stays green; "the pin is missing" | grep for the pin's own test file and run THAT |
| **VOID probe read as evidence** | two arms identical; "the fix does not work" | print the changed file's hash per arm; identical arms are VOID |
| **Verifying a stale tree** | arms anchor nothing | fetch AND fast-forward; kill the run and say so |
| **Dispatcher dirt** | a writer's rebase refuses mid-landing | commit and push dispatcher edits in one chained command |
| **Uncommitted writer work** | a silent writer's slice vanishes | briefs require a commit before BLOCKED; salvage-check before deleting |
| **Blessing duplication** | a baseline line added to make a new copy green | a folded copy must red as stale until its line is deleted |
| **Prose-only centralization** | "we agreed there is one way to do X" | land the fold with an "exactly one" pin |
| **Nudging a live writer** | "any progress?" every few minutes | wait for the report; the cadence contract is in the brief |
| **Board as history** | the board grows and stops being one screen | a record that is not the present belongs in the ledger or nowhere |
| **Ledger as behaviour doc** | the ledger restates how the code works | behaviour lives in a test; the ledger holds the decision |

## 14 · The smallest version that still works

One human, one dispatcher agent, one `AGENTS.md` with the engineering rules and the
`COPIES:` line, one gate script with a lock and a memory ceiling, one decision
ledger, one board with a reconciler, and the rule that **a landing is verified by the
dispatcher before it is retired**.

Every other mechanic here was added after a specific failure. Add them when you meet
the failure, not before.

## 15 · For the human: how to drive this

- **Give intent, not implementation.** "The spell chips should open the spell
  description" beats "add an onClick to SpellChip". If you *do* propose a mechanism
  and it is wrong, you get told once, with evidence.
- **Report what you SEE.** A screen is evidence; pasted text is transport and can be
  mangled before anyone sees it. Naming the screen halved a slice's scope in one line.
- **Say "log that in" when a decision matters.** Decisions become ledger rows that
  quote you, so a later slice does not re-litigate them.
- **Batch small reports, and split big ones.** Each landing costs a full verification
  gate; three independent defects can be one report with three lines.
- **Expect short, numeric reports** — counts, hashes, what went red, what the agent
  got wrong. Ask for the missing thing rather than re-reading the code.
- **Answer questions with a choice.** "A or B?" unlocks a dispatch; silence stops the
  queue. The agent is expected to ask rather than guess when two honest designs exist.
- **Push back on the three real failure modes**: a green test that does not go red
  when the fix is removed; a report containing "probably"; a record that says
  something you can see is untrue. Those are the signals that the process is being
  *performed* rather than *used*.
- **You may simply say "dispatch the queue".** The dispatcher will order it by value,
  keep at most two writers in flight, verify each landing itself, and report as they
  complete.

---

# Part 2 — How we run it on the DeepSeek Harness

Part 1 is portable and would work with any mechanism. This part is **deliberately
harness-bound**: it names DSH's actual tools, paths, limits and failure modes. If you
move to a different harness, re-derive this part — do not copy it.

## 1 · What DSH provides, and which role it serves

| Process need | DSH mechanism |
|---|---|
| Run a second agent with its own context | `subagent` (fresh context, self-contained prompt) and `subagent_fork` (inherits this conversation) |
| See which agents are live | `list_agents` (core: this session's continuable children, with status) |
| Steer or stop an agent | `send_message` (delivered at its next step boundary), `interrupt_agent` (stops the target's CURRENT turn only) |
| Retire an agent | `delete_subagent` / `release_subagent` / `list_subagents` — from the community plugin `dsh-plugin-subagent-delete`; the **core has no delete** |
| A long-running objective | goal tools (`create_goal` / `get_goal` / `update_goal`) |
| Run a long check without blocking | background jobs (`bash` with `run_in_background`, then `job_output` / `job_kill`) |
| Parallel writers in isolation | separate worktrees (git), one per writer |
| Carry rules into every session | `AGENTS.md` layering — `$DSH_HOME/AGENTS.md` (all projects) then the project's own |
| Reusable procedures | skills (loaded on demand) |

**Know which of these your harness actually has, and VERIFY it rather than assume.**
The delete/release pair is a plugin, not core: it exists only in a session started
**after** a profile restart, and its absence in an older session is not a defect. On a
harness with no delete, the branch and worktree are all you can retire.

## 2 · The clock and the gate (the binding harness contract)

This is the most harness-specific part of the process, and the part most expensive to
rediscover. Every rule was learned by burning one. The same text lives in
`~/.dsh/AGENTS.md` so it binds in **every** project, not just ones that have read this
document.

1. **Never run a long check in the foreground — in the session the OPERATOR talks
   to.** If a check can take minutes, launch it as a **background job** and act on the
   harness's completion notice. A foreground run there is minutes in which the session
   cannot respond, and the operator will interrupt it.
   **MEASURED COROLLARY: a SUBAGENT'S background jobs DIE when its turn ends.** A
   probe started a background `sleep 240`, ended its turn, and the process was gone
   ~20 seconds later, with an instrument control proving the check could look (8
   `bash` processes visible, zero `sleep`). So the background-and-wait pattern is
   valid **only** for a session that persists between turns. **A subagent must run its
   long check IN-TURN; foreground is CORRECT for a writer, because it blocks only its
   own session.** A writer that ended its turn "waiting for the notice" lost its
   entire full-gate run — observed as a log that stops mid-chunk with no summary and a
   released lock.
2. **Never poll.** No blocking waits on a job, no sleep-and-check loops, no repeated
   status peeks. The harness notifies when a job settles, and that notice **is** the
   wake event. While waiting, do useful non-conflicting work, or end the turn.
3. **One expensive check at a time, enforced by an atomic lock — not by a glance.**
   Two observers can look in the same instant and both see "free", so the second
   starter must be refused *by the lock itself*. A refusal is the lock **working**:
   never a failure, never evidence, and the refused run is **void**. A cheap check
   that reads nothing shared should **not** take the lock, so it can run alongside.
4. **Exit codes are the vocabulary — quote them exactly and never inflate them.**
   Write each code's meaning into the runner and repeat it verbatim. The working set
   used here:
   | Code | Meaning |
   |---|---|
   | `0` | fully verified — the requested tier ran and passed |
   | `1` | the tier ran and FAILED (read the raw log) |
   | `2` | the cheap tier ran and the expensive one did **not** |
   | `9` (or a "busy" code) | refused by the lock — **VOID**, not a failure |
   **"It compiles" is never "it passed."**
5. **Pick the cheapest tier that answers the question the change actually asks.**
   Prose and records need compile/lint; behaviour needs the suite. Beware the PARITY
   trap: a diff taken against the remote base is **empty** once everything is pushed,
   so a "docs-only" skip can silently become a full run — decide the tier from what
   **changed**, not from what happens to be uncommitted.
6. **Never pipe a check through `tail`/`head`.** Two reasons, the second worse than
   the first: it destroys the failing evidence (the test's name and its
   expected/received block), and — because a pipeline's exit status is the **last**
   command's — `check | tail` returns success whatever the check did, so an
   `&& commit && push` chain lands unverified work beneath a message claiming a pass.
   Keep the raw log and quote from the file.

## 3 · Tiers: what blocks a push, and what follows it

The two-tier split is a strategy (Part 1) with a concrete DSH shape:

- **The cheap tier blocks the push.** It runs what can break a deploy
  (typecheck/build), takes no lock, and exits `2`. It must never be reported as "the
  gate passed".
- **The expensive tier is the one that makes a change VERIFIED.** The **dispatcher**
  owns it, once per landing, on the integrated tree, as a background job under the
  lock — and the same session stays in-session to watch it (an unwatched background
  gate is how a red result gets lost).
- **A writer runs the expensive tier only when the slice touches the verification
  machinery itself** (the gate script, build config, test setup). Only running the
  suite *through* those can verify them. Otherwise the writer's report carries the
  cheap tier, and the dispatcher's integrated run follows.
- **A red expensive tier is fixed forward immediately**, never stacked behind another
  unverified commit.

The trade is explicit and bounded: the remote may carry an unverified commit for the
few minutes the full tier runs. That is acceptable only while the project has a single
consumer, and it **reverts to gate-then-push** the moment a second user or a second
consumer of the main branch exists.

## 4 · Worktrees on this host

`<repo>/worktrees/<slice>` — **in-repo, always.** The rule is not a preference; it is
forced by the sandbox:

- Under the restricted file sandbox, `/tmp` is a **per-call tmpfs**: a write succeeds
  and the file is gone in the next call. A worktree created there does not survive to
  the next bash call, so a writer following a `/tmp` recipe would edit the MAIN tree
  and destroy the parallel-writer guarantee.
- Under the permissive mode `/tmp` is an ordinary persistent tmpfs — which is exactly
  why the in-repo recipe is the ONE recipe: **a location that exists only while the
  mode is permissive breaks silently the moment the mode is not**, and the mode has
  changed under this workspace before.
- `worktrees/` is gitignored and excluded from lint, so the main tree stays clean.
- The suite lock is derived from the **git common dir**, so it is the same path from
  the main tree and every worktree — which is what makes it one lock across writers.

Two traps specific to in-repo worktrees, both measured:

- **A hardlink-cloned `node_modules` may not be written through.** If you clone the
  main tree's modules with `cp -al`, `rm` a file before writing its replacement —
  never edit in place — then verify with `ls -li` that the copies have different
  inodes. Editing through a hardlink corrupts the MAIN tree's state file, and the
  symptom is a **false type failure with no type error behind it**. Diagnose that from
  the gate's own log, not from the change.
- **A worktree instruction is not self-enforcing.** Every bash call is a fresh shell
  whose cwd is the session workspace, and file tools resolve relative paths against
  that workspace. Every brief must say so, and every file operation in a worktree
  session must use absolute paths.

## 5 · The chief-of-staff standing role

`~/.dsh/AGENTS.md` carries this role **host-globally**, because the owner designates
it per session and a project that has never heard of it still has to work. The
harness-specific parts:

- **One frozen goal.** Create the session's single goal once and **pause it
  immediately** — the designation authorizes exactly those two touches. Never
  re-scope, resume or complete it: a paused goal never ticks, and every goal update
  burns the session's shared goal budget (a previous chat died at the goal limit from
  per-task goal churn). Task state lives in the todo list and the agent registry —
  never in goal revisions.
- **Wake events only**: an owner message, a writer's landing/BLOCKED report, or a
  runtime failure notice. **A parked tick is not a work order and gets silence.** A
  tick that still arrives while work is delegated: do not nudge, do not re-dispatch,
  do not narrate "holding".
- **`running` means alive.** A clean tree with no new commit while the registry says
  running is normal for a deep-verify or long-generation phase — never grounds for a
  nudge, let alone a deletion. A writer is salvage-checked only after the registry
  shows it is **not** running.
- **A nudge is a last resort** for real stagnation (registry idle or ready with no
  report across checks), and it may not demand intermediate reports.
- **Round-budget pressure is never the writer's problem.** If rounds run short while
  work is in flight, raise the cap and stay paused; compressing a writer to satisfy a
  tick is forbidden.

## 6 · Subagent hygiene (retiring is part of the work)

The session list holds in-flight work only — **a short list is a correct list.**
Stale sessions have caused real confusion: a finished agent mistaken for pending work,
a stopped one lingering for days.

- **Delete a probe** as soon as its report is consumed.
- **Delete a writer** only after its landing is verified on the remote by commit SHA.
  **Never delete a running writer.**
- **A BLOCKED writer** is deleted once its reasoning is captured and the salvage check
  confirms what it did or did not write.
- **A silent writer is salvage-checked BEFORE deletion**: the branch log for unpushed
  commits, the worktree status for uncommitted work — verified against the remote,
  never assumed landed or lost.
- **Retire the branch, not just the worktree**: session deleted, `git worktree remove`
  + prune, AND the branch deleted. Remote branches are shared state — delete only with
  the owner's explicit go-ahead, and record every deleted tip SHA in the report as the
  recovery pointer.
- **Safe-delete test for a branch**: deletable when `git log --oneline main..<branch>`
  is empty. If it is not, do not delete and do not assume loss — the branch may be a
  superseded iteration whose content landed under rewritten history.

## 7 · Host hygiene (the box is shared)

Real incident, owner-visible: four writers in flight plus a load generator drove the
load average to ~106 on an 8-core box and starved everything; DSH had to be restarted
by the owner. Second occurrence: a writer's **unbounded** test run outlived its turn
and kept going. Third: the kernel OOM-killed the harness itself.

- **At most TWO writers in flight.** Count the registry before dispatching; a verified
  landing frees a slot.
- **No synthetic load, ever.** No busy-loops, no stress harnesses, no N-way suite
  hammering. A flake is proved deterministic by *delaying its cause* and repeating
  sequentially — never by loading the machine.
- **A gate is a lock, and every run carries a memory ceiling.** One suite at a time in
  the whole session; the lock is **in the repo**, not `/tmp` (see §4). A lock whose
  owner file is older than ~30 minutes with no suite process alive is **stale**:
  remove it and say so.
- **An interrupted turn's processes are the dispatcher's to reap.** A turn that dies —
  restart, crash, killed session — does NOT kill what it started. After any restart or
  interrupted writer, the dispatcher's FIRST action is a process audit, and it kills
  the orphans before dispatching anything new.
- **Kill by PID with a self-excluding pattern.** A command line containing the pattern
  it greps for matches itself: `pkill -f "vitest run"` can SIGTERM its own shell, and a
  combined `pgrep` one-liner reports BUSY forever. Build the pattern so the killer
  cannot match it, use `pgrep -af "vites[t]"`, then kill by PID.
- **Ownership is the worktree path in the COMMAND LINE**, not `cwd` — `cwd` is
  unreadable for subagent-owned processes and silently matches nothing.
- **Foreign suites are waited for, not reaped.** Another DSH project may share this
  box; a suite you did not start is not yours.
- **Nothing outlives the writer.** Scratch harnesses live under the writer's own
  worktree or the gate's workspace log dir, never `/tmp`; every process it starts is
  foreground or killed before it reports.
- **An OOM-killed session is indistinguishable from a writer dying silently with an
  empty report** — memory pressure destroys WORK, not merely responsiveness.

## 8 · Host facts a successor needs immediately

- **Never touch `~/.openclaw`.** That belongs to a **different** agent platform. Do
  not read, write, move or delete anything under it; if a task seems to require it,
  **stop and ask**.
- Projects live under `~/projects`, one git repo each; the harness workspace symlinks
  them. This machine is also another platform's host, so treat everything outside your
  project as someone else's.
- `pnpm` lives at `~/.local/bin/pnpm`; the **shared store** is
  `~/.local/share/pnpm/store`. Reuse it — do not create per-project stores or caches.
- **File effects run unconfined by deliberate operator choice.** Do not reintroduce
  per-project sandbox workarounds; the constraint was resolved by removing
  confinement.
- The GUI is served at `127.0.0.1:3080`. Client-plugin changes hot-reload only while a
  web dev watcher is running; every other web change needs a rebuild and a refresh.
- **A long check started by a subagent dies with its turn** (§2, rule 1). This is the
  single most expensive fact to rediscover, which is why it is stated twice.

## 9 · Starting a session on DSH — the reconcile pass

1. Read the project's board/record and its `AGENTS.md`.
2. Run the reconciler (`board.sh` or equivalent): the board is prose about state —
   **checked, never believed**.
3. Compare its writer records against the **live registry** (`list_agents`, plus
   `list_subagents` where the plugin is installed) and the host (`uptime`, orphan
   suites, the suite lock).
4. Fix the record where it lied, report ONE line, then wait for a request.
5. If designated **chief of staff**: create the single goal once and **pause it**, and
   open no further goal updates.

Only then dispatch. Nothing is dispatched before that pass.

---

## The one-line summary

A human supplies intent and decisions; **one** agent acts as chief of staff; short-lived
writers each deliver **one verified slice** from their own worktree; the state that
matters lives **on disk**; and **work is only done when someone other than its author
has verified it.**
