// Tests for tools/socket-peers/find-socket-peers.mjs
//
// Policy: new work ships with a test. The pure parsers are unit-tested, and the
// whole tool is exercised end-to-end against a FIXTURE /proc and a FIXTURE tcp table
// so the assertions never depend on whatever this machine happens to be doing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseAddress,
  parseTcpTable,
  listenPorts,
  pairConnections,
  readOwners,
  summarize,
} from './find-socket-peers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'find-socket-peers.mjs');

// 3080 = 0C08, 3081 = 0C09, 59916 = EA0C
const TCP_FIXTURE = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:0C09 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333 1 0 100 0 0 10 0',
  '   1: 0100007F:0C08 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1 0 100 0 0 10 0',
  '   2: 0100007F:0C08 0100007F:EA0C 01 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0 10 0',
  '   3: 0100007F:EA0C 0100007F:0C08 01 00000000:00000000 00:00000000 00000000  1000        0 222 1 0 100 0 0 10 0',
  '   this line is malformed and must be skipped, never fatal',
  '',
].join('\n');

/** A fake /proc: pids with fd symlinks pointing at socket inodes. */
function fixtureProc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sockpeers-proc-'));
  const mk = (pid, comm, inodes) => {
    const base = path.join(dir, String(pid));
    fs.mkdirSync(path.join(base, 'fd'), { recursive: true });
    fs.writeFileSync(path.join(base, 'comm'), `${comm}\n`);
    inodes.forEach((inode, i) => {
      fs.symlinkSync(`socket:[${inode}]`, path.join(base, 'fd', String(i + 3)));
    });
  };
  mk(1000, 'dshweb', [111, 444]);
  mk(2000, 'bridge', [222, 333]);
  fs.symlinkSync('/dev/null', path.join(dir, '1000', 'fd', '9')); // a non-socket fd
  return dir;
}

test('parseAddress decodes IPv4 and IPv6 little-endian fields', () => {
  assert.deepEqual(parseAddress('0100007F:0C08'), { ip: '127.0.0.1', port: 3080 });
  assert.deepEqual(parseAddress('00000000:0000'), { ip: '0.0.0.0', port: 0 });
  assert.deepEqual(
    parseAddress('00000000000000000000000001000000:1F90'),
    { ip: '::1', port: 8080 },
  );
  assert.equal(parseAddress('nonsense'), null);
});

test('parseTcpTable parses entries and counts malformed lines instead of throwing', () => {
  const { entries, malformed } = parseTcpTable(TCP_FIXTURE);
  assert.equal(entries.length, 4);
  assert.equal(malformed, 1, 'the junk line is counted, not fatal');
  assert.equal(entries[2].state, '01');
  assert.equal(entries[2].inode, '111');
  assert.deepEqual(listenPorts(entries), new Set([3080, 3081]));
});

test('pairConnections matches each established socket to its peer', () => {
  const { entries } = parseTcpTable(TCP_FIXTURE);
  const pairs = pairConnections(entries);
  assert.equal(pairs.length, 2, 'two established sockets, i.e. one connection');
  const server = pairs.find((p) => p.local.port === 3080);
  const client = pairs.find((p) => p.local.port === 59916);
  assert.equal(server.localInode, '111');
  assert.equal(server.peerInode, '222', 'the peer end is attributed, not left unknown');
  assert.equal(client.localInode, '222');
  assert.equal(client.peerInode, '111');
});

test('summarize separates client-end from server-end and names the pair', () => {
  const { entries } = parseTcpTable(TCP_FIXTURE);
  const listen = listenPorts(entries);
  const pairs = pairConnections(entries);
  const { owners } = readOwners(fixtureProc());
  const s = summarize(pairs, owners, listen, {});

  const server = s.processes.find((p) => p.pid === 1000);
  const client = s.processes.find((p) => p.pid === 2000);
  assert.equal(server.serverEnd, 1, 'the listener-side process holds the server end');
  assert.equal(server.clientEnd, 0);
  assert.equal(client.clientEnd, 1, 'the dialling process holds the client end');
  assert.equal(client.serverEnd, 0);

  assert.equal(s.pairs.length, 1);
  assert.match(s.pairs[0].pair, /dshweb\(1000\) :3080/);
  assert.match(s.pairs[0].pair, /bridge\(2000\)/);
  assert.equal(s.pairs[0].count, 1);
});

test('summarize --port filters to connections touching that port', () => {
  const { entries } = parseTcpTable(TCP_FIXTURE);
  const listen = listenPorts(entries);
  const pairs = pairConnections(entries);
  const { owners } = readOwners(fixtureProc());
  const none = summarize(pairs, owners, listen, { port: 9999 });
  assert.equal(none.processes.length, 0);
  const hit = summarize(pairs, owners, listen, { port: 3080 });
  assert.equal(hit.processes.length, 2);
});

test('end-to-end: flags the process holding client-end sockets it never released', () => {
  const proc = fixtureProc();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sockpeers-tcp-'));
  const tcp = path.join(dir, 'tcp');
  fs.writeFileSync(tcp, TCP_FIXTURE);
  try {
    const run = spawnSync(
      process.execPath,
      [TOOL, '--proc', proc, '--tcp', tcp, '--flag', '1'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, `must exit 0; stderr: ${run.stderr}`);
    assert.match(run.stdout, /BOTH ends attributed/);
    assert.match(run.stdout, /CANDIDATES requiring human review/);
    // The counters are the evidence that the scan actually happened.
    assert.match(run.stdout, /4 tcp entries from 1 table\(s\); 1 malformed skipped/);
    assert.match(run.stdout, /ESTABLISHED: 2/);
    // The pair is named with BOTH sides — the whole point of the tool.
    assert.match(run.stdout, /dshweb\(1000\) :3080 {2}<-> {2}bridge\(2000\)/);
    // And the dialling process is flagged; the accepting one is not.
    assert.match(run.stdout, /bridge.*asymmetry \+1/);
    assert.ok(!/dshweb.*asymmetry/.test(run.stdout), 'the listener side must not be flagged');
  } finally {
    fs.rmSync(proc, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: exit 0 and a loud line when no tcp table can be read', () => {
  const run = spawnSync(
    process.execPath,
    [TOOL, '--proc', '/proc', '--tcp', '/nonexistent/tcp'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 1, 'a real error exits non-zero');
  assert.match(run.stderr, /no tcp table could be read/);
});
