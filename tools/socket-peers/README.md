# `socket-peers` — who holds the *other* end?

`npm run socket:peers`
`node tools/socket-peers/find-socket-peers.mjs [--port N] [--top N] [--flag N] [--proc DIR] [--tcp FILE]`

Attributes **both ends** of every loopback connection to the process that owns it, and
flags any process holding many **client-end** sockets against few **server-end** ones —
the signature of a process accumulating connections for clients that are gone.

It is a **pointer, not a judge**: a large asymmetry is a *candidate* for "this is an
accumulator", never a verdict. A busy reverse proxy legitimately holds many client-end
sockets.

---

## The problem it solves

A real investigation (2026-09-27) counted the connections into a server — 90–106
ESTABLISHED, climbing — and attributed only the **server** end. It then cleared the
auth proxy in front of it because the proxy held "only 2 sockets". Those 2 were the
proxy's *listener* side. The proxy was the accumulator: it held **102** sockets as the
**client** on the server's port, against **3** accepted clients. The server was the
victim.

A loopback connection appears **twice** in the socket table, once per end. Any query
that filters by state, or by one local port, sees only one of them — and the process
you are looking at may be at the other end. This tool exists so that "who holds the
other end?" is one command instead of an assumption.

---

## How it works

1. **Read** `/proc/net/tcp` and `/proc/net/tcp6` (read-only). Each line gives one
   socket: local address, remote address, state, inode.
2. **Pair** each `ESTABLISHED` socket with its peer's socket by matching the *swapped*
   `(local, remote)` pair. A peer that is not on this host has no entry — reported as
   `external`, never guessed.
3. **Attribute** every inode to a PID by scanning `/proc/<pid>/fd` for
   `socket:[inode]` symlinks. A process whose fds are unreadable (another user, or it
   exited mid-scan) is **counted**, never silently dropped.
4. **Classify** each socket as `client-end` (its local port is not a listening port —
   this process dialled out) or `server-end` (it is — this process accepted), using
   the set of LISTEN ports in the same table.
5. **Count connections once.** A connection has two sockets; the pair table dedupes by
   the unordered inode pair, so a count is *connections*, not *sockets*.

## Reading the output

```
Scan: 84 tcp entries from 2 table(s); 0 malformed skipped
  ESTABLISHED: 21 (8 with a non-local peer)
  owners: 312 inodes from 384 socket fds; 330 process(es) unreadable
  attributed: 11; unattributed: 11

== Processes by sockets held (top 20) ==
  dsh-auth-bridge      pid 3852060  client   102  server     3   <-- asymmetry +99
  dsh web              pid 2207466  client     2  server   102

== Connections by owning pair (top 20) ==
    102  dsh web(2207466) :3080  <->  dsh-auth-bridge(3852060)
```

`client-end = dialled out`, `server-end = accepted`. The counters are the evidence
that the scan actually happened: entries read, sockets attributed, processes that
could not be read, peers that are not local.

**The pair table is the answer to the question.** If the same pair appears ~100 times
while one side has almost no accepted clients, that side is holding sockets nobody is
using.

## Flags

| Flag | Effect |
| --- | --- |
| *(none)* | flag any process with `client-end − server-end ≥ 10` and `client-end ≥ 10` |
| `--port N` | only connections where either end is port `N` |
| `--flag N` | retune the asymmetry threshold (use `--flag 1` on a quiet host) |
| `--top N` | rows per table (default 20) |
| `--proc DIR` / `--tcp FILE` | point at a fixture instead of the live `/proc` (how the tests run) |

## Limitations (stated plainly)

- **Linux `/proc` only.** It reads `/proc/net/tcp` and `/proc/<pid>/fd`, which do not
  exist on macOS or Windows. On another OS it fails loudly, it does not guess.
- **Another user's processes are invisible.** Without privileges their fds cannot be
  read; those sockets land in `unattributed` and the process count is printed.
- **A snapshot, not a trend.** Run it twice and compare; the tool does not sample over
  time (deliberately — no polling).
- **It cannot tell a leak from a workload.** That is the human's call, and the reason
  the output says "candidates".

## Files

- `find-socket-peers.mjs` — the tool (CLI + exported pure helpers).
- `find-socket-peers.test.mjs` — `node:test` unit tests for the parsers, plus an
  end-to-end run against a **fixture** `/proc` and tcp table, so the assertions never
  depend on what this machine happens to be doing.
- `../../tools/README.md` — folder rules and the port-to-another-project checklist.
