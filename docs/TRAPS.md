# Traps — mistakes that actually happened

One entry per trap: what it looks like, why it happens, and the rule that prevents it.
Every entry here **cost someone real time**. A trap that is never written down gets
re-made by the next person in a hurry. Read the one that matches what you are doing
right now.

These are field notes, not process. For the process itself see
[`WAY-OF-WORKING.md`](WAY-OF-WORKING.md).

---

## TRAP — a half-closed socket never emits `close`

**What it looks like.** You hold two sockets together — a proxy, a tunnel, a pipe —
and you attach the teardown to `'close'`. A client vanishes. The socket leaves the
kernel table. **Your teardown never runs**, and sockets accumulate. Measured
2026-09-27: a loopback auth proxy held **102** upstream sockets against **3** live
clients, and the server in front of it looked like the leaker.

**Why.** Node emits `'close'` only when **both halves** of a socket are done. A peer
that disappears before an upgrade resolves leaves the socket **half-closed** —
`readableEnded === true`, `writableEnded === false`, `destroyed === false` — so
`'close'` never fires. A minimal server shows it directly:

```
CONN
UPGRADE dst_destroyed=false readableFlowing=null
  socket END                                     ← the FIN did arrive
  +600ms readableEnded=true writableEnded=false   ← half-closed; no 'close', ever
```

**The rule.**

- Tear down on **`'end'` as well as `'close'`** when you splice two sockets.
- When you take over a socket, guard on `destroyed || readableEnded || !writable`.
  `destroyed` and `writable` are **both false** in this state, so a guard that checks
  only those — the natural first attempt — never fires.

**Reproducing it (the useful part).** A normal local server is **too fast** to hit the
race: the upgrade resolves before the client's FIN is processed, and the leak does not
appear. Point the proxy at a deliberately **slow upstream** that completes the upgrade
late, and have the client drop immediately:

```
8 abandoned upgrades →  old code = 8 sockets leaked
                        fixed    = 0
```

Cost of not knowing this: two wrong fixes, each of which looked correct and was
disproved only by running it.

---

## TRAP — counting ONE end, then "ruling out" the wrong component

**What it looks like.** A server shows 90–106 established connections, climbing. You
count the sockets the suspect proxy holds — 2 — and clear it. The proxy was the
accumulator: those 2 were its **listener** side; it held **102** as the **client** on
the server's port.

**Why.** A loopback connection appears **twice** in the socket table, once per end. Any
query filtered by state, or by one local port, sees only one of them — and the process
you are looking at may be at the other end.

**The rule.** Before ruling a process out, **attribute BOTH ends**, and compare what it
holds as the client against what it holds as the server. Many client-end sockets with
few server-end ones is the accumulator; the process accepting them is the victim.

**The tool.** [`../tools/socket-peers/`](../tools/socket-peers/README.md) does exactly
this — `npm run socket:peers` — and prints the owning pair for every connection.
