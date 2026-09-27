#!/usr/bin/env node
/**
 * find-socket-peers.mjs
 *
 * "Who holds the OTHER end?" — attribute BOTH ends of every loopback connection to
 * the process that owns it, then flag the process holding sockets for clients that
 * are gone.
 *
 * WHY THIS EXISTS. A real investigation (2026-09-27) counted the connections into a
 * server (`dsh web`, 90-106 ESTABLISHED and climbing), attributed only the SERVER
 * end, and ruled out the proxy in front of it because the proxy held "only 2
 * sockets" — those were its LISTENER side. The proxy was the accumulator: it held
 * 102 sockets as the CLIENT on the server's port against 3 accepted clients. A tool
 * that attributes both ends answers in one line what a one-sided count gets wrong.
 *
 * It is a POINTER, not a judge: a large client/server asymmetry is a CANDIDATE for
 * "this process is accumulating connections", never a verdict. A busy reverse proxy
 * legitimately holds many client-end sockets.
 *
 * Read-only. Dependency-free (Node built-ins only). Linux `/proc` only — it reads
 * `/proc/net/tcp{,6}` and `/proc/<pid>/fd`, which do not exist on macOS/Windows.
 *
 * Exit 0 on success; non-zero only for a real error (unreadable /proc, bad args).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TCP_STATE_ESTABLISHED = '01';
const TCP_STATE_LISTEN = '0A';

/** Decode a `/proc/net/tcp{,6}` address field (`HEXIP:HEXPORT`). */
export function parseAddress(hex) {
  const raw = String(hex);
  const cut = raw.lastIndexOf(':');
  if (cut < 0) return null;
  const addr = raw.slice(0, cut);
  const port = Number.parseInt(raw.slice(cut + 1), 16);
  if (!Number.isFinite(port)) return null;

  if (addr.length === 8) {
    // IPv4: four bytes, little-endian.
    const bytes = [];
    for (let i = 6; i >= 0; i -= 2) bytes.push(Number.parseInt(addr.slice(i, i + 2), 16));
    return { ip: bytes.join('.'), port };
  }
  if (addr.length === 32) {
    // IPv6: four little-endian 32-bit words -> 16 bytes -> 8 groups.
    const bytes = [];
    for (let w = 0; w < 4; w += 1) {
      const word = addr.slice(w * 8, w * 8 + 8);
      for (let i = 6; i >= 0; i -= 2) bytes.push(Number.parseInt(word.slice(i, i + 2), 16));
    }
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    return { ip: compressV6(groups), port };
  }
  return null;
}

/** Standard `::` compression of eight 16-bit groups. */
function compressV6(groups) {
  let best = { start: -1, len: 0 };
  let cur = { start: -1, len: 0 };
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === '0') {
      if (cur.start < 0) cur = { start: i, len: 1 };
      else cur.len += 1;
      if (cur.len > best.len) best = { start: cur.start, len: cur.len };
    } else {
      cur = { start: -1, len: 0 };
    }
  }
  if (best.len < 2) return groups.join(':');
  const head = groups.slice(0, best.start).join(':');
  const tail = groups.slice(best.start + best.len).join(':');
  return `${head}::${tail}`;
}

/**
 * Parse a `/proc/net/tcp` (or tcp6) table.
 * The inode column is the 10th field; a malformed line is skipped, never fatal.
 */
export function parseTcpTable(text) {
  const out = [];
  let malformed = 0;
  const lines = String(text).split('\n');
  for (const line of lines.slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) {
      if (line.trim() !== '') malformed += 1;
      continue;
    }
    const local = parseAddress(f[1]);
    const remote = parseAddress(f[2]);
    if (!local || !remote) {
      malformed += 1;
      continue;
    }
    out.push({ local, remote, state: f[3], inode: f[9] });
  }
  return { entries: out, malformed };
}

/** The set of ports anything is LISTENing on, used to tell the two ends apart. */
export function listenPorts(entries) {
  const ports = new Set();
  for (const e of entries) if (e.state === TCP_STATE_LISTEN) ports.add(e.local.port);
  return ports;
}

/**
 * Pair each ESTABLISHED socket with its peer's socket entry, by matching the
 * swapped (local, remote) address pair. Both ends are on this host, so both appear
 * in the table; a peer that is NOT local gets `peerInode: null` (external).
 */
export function pairConnections(entries) {
  const key = (a) => `${a.ip}:${a.port}`;
  const byLocal = new Map();
  for (const e of entries) {
    if (e.state !== TCP_STATE_ESTABLISHED) continue;
    const k = key(e.local);
    if (!byLocal.has(k)) byLocal.set(k, []);
    byLocal.get(k).push(e);
  }
  const pairs = [];
  for (const e of entries) {
    if (e.state !== TCP_STATE_ESTABLISHED) continue;
    const candidates = byLocal.get(key(e.remote)) || [];
    const peer = candidates.find((c) => key(c.remote) === key(e.local)) || null;
    pairs.push({
      local: e.local,
      remote: e.remote,
      localInode: e.inode,
      peerInode: peer ? peer.inode : null,
    });
  }
  return pairs;
}

/** Map socket inode -> {pid, comm} by reading `/proc/<pid>/fd` symlinks. */
export function readOwners(procDir = '/proc') {
  const owners = new Map();
  let scanned = 0;
  let unreadable = 0;
  let pids;
  try {
    pids = fs.readdirSync(procDir).filter((n) => /^\d+$/.test(n));
  } catch (err) {
    throw new Error(`cannot read ${procDir}: ${err.code || err.message}`);
  }
  for (const pid of pids) {
    const fdDir = path.join(procDir, pid, 'fd');
    let fds;
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      unreadable += 1; // another user's process, or it exited mid-scan
      continue;
    }
    let comm = '';
    try {
      comm = fs.readFileSync(path.join(procDir, pid, 'comm'), 'utf8').trim();
    } catch {
      comm = '';
    }
    for (const fd of fds) {
      let link;
      try {
        link = fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (!m) continue;
      scanned += 1;
      if (!owners.has(m[1])) owners.set(m[1], { pid: Number(pid), comm });
    }
  }
  return { owners, scanned, unreadable };
}

/**
 * Per-process client-end vs server-end counts, plus per-owning-pair counts.
 * `clientEnd` = the socket's LOCAL port is not a listening port (this process
 * dialled out); `serverEnd` = it is (this process accepted).
 */
export function summarize(pairs, owners, listen, opts = {}) {
  const label = (o) => (o ? `${o.comm || '?'}(${o.pid})` : 'unknown');
  const byPid = new Map();
  const byPair = new Map();
  const seenConnections = new Set();
  let attributed = 0;
  let unattributed = 0;
  let external = 0;

  for (const p of pairs) {
    if (opts.port !== undefined && p.local.port !== opts.port && p.remote.port !== opts.port) {
      continue;
    }
    const lo = owners.get(p.localInode) || null;
    const po = p.peerInode ? owners.get(p.peerInode) || null : null;
    if (!p.peerInode) external += 1;
    if (lo) attributed += 1;
    else unattributed += 1;

    if (lo) {
      const pid = lo.pid;
      if (!byPid.has(pid)) {
        byPid.set(pid, { pid, comm: lo.comm, clientEnd: 0, serverEnd: 0, external: 0 });
      }
      const rec = byPid.get(pid);
      if (listen.has(p.local.port)) rec.serverEnd += 1;
      else rec.clientEnd += 1;
      if (!p.peerInode) rec.external += 1;
    }

    if (lo && po) {
      // A connection has TWO established sockets, one per end, so count it ONCE.
      const connKey = [p.localInode, p.peerInode].sort().join('-');
      if (!seenConnections.has(connKey)) {
        seenConnections.add(connKey);
        const serverSide = listen.has(p.local.port)
          ? `${label(lo)} :${p.local.port}`
          : `${label(po)} :${p.remote.port}`;
        const clientSide = listen.has(p.local.port) ? label(po) : label(lo);
        const k = `${serverSide}  <->  ${clientSide}`;
        byPair.set(k, (byPair.get(k) || 0) + 1);
      }
    }
  }

  const processes = [...byPid.values()].sort(
    (x, y) => (y.clientEnd + y.serverEnd) - (x.clientEnd + x.serverEnd)
      || (y.clientEnd - y.serverEnd) - (x.clientEnd - x.serverEnd)
      || x.pid - y.pid,
  );
  const pairsOut = [...byPair.entries()]
    .map(([k, n]) => ({ pair: k, count: n }))
    .sort((x, y) => y.count - x.count || (x.pair < y.pair ? -1 : 1));

  return { processes, pairs: pairsOut, attributed, unattributed, external };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const FLAG_THRESHOLD_DEFAULT = 10;
const TOP_DEFAULT = 20;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--port') opts.port = Number.parseInt(argv[++i], 10);
    else if (arg.startsWith('--port=')) opts.port = Number.parseInt(arg.slice(7), 10);
    else if (arg === '--top') opts.top = Number.parseInt(argv[++i], 10);
    else if (arg.startsWith('--top=')) opts.top = Number.parseInt(arg.slice(6), 10);
    else if (arg === '--flag') opts.flag = Number.parseInt(argv[++i], 10);
    else if (arg.startsWith('--flag=')) opts.flag = Number.parseInt(arg.slice(7), 10);
    else if (arg === '--proc') opts.proc = argv[++i];
    else if (arg.startsWith('--proc=')) opts.proc = arg.slice(7);
    else if (arg === '--tcp') opts.tcp = argv[++i];
    else if (arg.startsWith('--tcp=')) opts.tcp = arg.slice(6);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log([
      'Usage: node tools/socket-peers/find-socket-peers.mjs [options]',
      '',
      'Attributes BOTH ends of every loopback connection to its owning process, and',
      'flags the process holding many client-end sockets against few server-end ones',
      '(the signature of a proxy accumulating connections for clients that are gone).',
      '',
      'Options:',
      '  --port N      only connections where either end is port N',
      '  --top N       rows per table                         (default: 20)',
      '  --flag N      client-end minus server-end to flag    (default: 10)',
      '  --proc DIR    /proc root                             (default: /proc)',
      '  --tcp FILE    tcp table(s), comma-separated          (default: /proc/net/tcp,/proc/net/tcp6)',
      '  -h, --help    show this help',
      '',
      'Read-only, dependency-free, Linux /proc only. Candidates require human review:',
      'a busy reverse proxy legitimately holds many client-end sockets.',
    ].join('\n'));
    return;
  }

  const procDir = args.proc || '/proc';
  const tcpFiles = (args.tcp || '/proc/net/tcp,/proc/net/tcp6').split(',').filter(Boolean);
  const top = Number.isFinite(args.top) && args.top > 0 ? args.top : TOP_DEFAULT;
  const flagAt = Number.isFinite(args.flag) ? args.flag : FLAG_THRESHOLD_DEFAULT;

  const entries = [];
  let malformed = 0;
  let tablesRead = 0;
  for (const file of tcpFiles) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // an absent tcp6 table is normal
    }
    const parsed = parseTcpTable(text);
    entries.push(...parsed.entries);
    malformed += parsed.malformed;
    tablesRead += 1;
  }
  if (tablesRead === 0) {
    console.error(`error: no tcp table could be read (tried: ${tcpFiles.join(', ')})`);
    process.exitCode = 1;
    return;
  }

  const listen = listenPorts(entries);
  const pairs = pairConnections(entries);
  let ownerScan;
  try {
    ownerScan = readOwners(procDir);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const portFilter = Number.isFinite(args.port) ? args.port : undefined;
  const summary = summarize(pairs, ownerScan.owners, listen, { port: portFilter });

  console.log('Socket peers — BOTH ends attributed (Linux /proc, read-only)');
  console.log('These are CANDIDATES requiring human review, not verdicts.');
  console.log('');
  console.log(`Scan: ${entries.length} tcp entries from ${tablesRead} table(s); ${malformed} malformed skipped`);
  const estab = entries.filter((e) => e.state === TCP_STATE_ESTABLISHED).length;
  console.log(`  ESTABLISHED: ${estab} (${summary.external} with a non-local peer)`);
  console.log(`  owners: ${ownerScan.owners.size} inodes from ${ownerScan.scanned} socket fds; ${ownerScan.unreadable} process(es) unreadable`);
  console.log(`  attributed: ${summary.attributed}; unattributed: ${summary.unattributed}`);
  if (portFilter !== undefined) console.log(`  filtered to port ${portFilter}`);
  console.log('');

  console.log(`== Processes by sockets held (top ${top}) ==`);
  console.log('  client-end = dialled out;  server-end = accepted.  A large positive');
  console.log('  asymmetry is an accumulator CANDIDATE.');
  const flagged = summary.processes.filter((p) => (p.clientEnd - p.serverEnd) >= flagAt && p.clientEnd >= flagAt);
  if (summary.processes.length === 0) {
    console.log('  (none)');
  } else {
    for (const p of summary.processes.slice(0, top)) {
      const asym = p.clientEnd - p.serverEnd;
      const mark = flagged.includes(p) ? `   <-- asymmetry +${asym}` : '';
      console.log(`  ${(p.comm || '?').padEnd(20)} pid ${String(p.pid).padEnd(8)} client ${String(p.clientEnd).padStart(5)}  server ${String(p.serverEnd).padStart(5)}${mark}`);
    }
  }
  console.log('');

  console.log(`== Connections by owning pair (top ${top}) ==`);
  if (summary.pairs.length === 0) {
    console.log('  (none)');
  } else {
    for (const p of summary.pairs.slice(0, top)) {
      console.log(`  ${String(p.count).padStart(5)}  ${p.pair}`);
    }
  }
  console.log('');
  if (flagged.length > 0) {
    console.log(`Flagged ${flagged.length} process(es) at or above the asymmetry threshold ${flagAt} (--flag N to retune).`);
  } else {
    console.log(`No process reached the asymmetry threshold ${flagAt} (--flag N to retune).`);
  }
  console.log('A flagged process may be doing its job: confirm by checking whether its');
  console.log('peer count matches the clients actually connected.');

  process.exitCode = 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
