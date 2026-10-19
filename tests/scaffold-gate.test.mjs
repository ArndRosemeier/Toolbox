// Behavioral pins for the SCAFFOLD gate's journal.
//
// The journal is the cross-tool record: a DSH run and a Claude Code run must land in
// the SAME file, with a `runtime=` that says which ran. The gate's exit-code
// vocabulary is the other half: a refused run (9) is VOID and must still be
// journaled, or the stats silently lose every refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'scaffold', 'scripts', 'gate.sh');

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-gate-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Scaffold Test');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(GATE, path.join(dir, 'scripts', 'gate.sh'));
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  return dir;
}

function run(dir, env = {}) {
  return spawnSync('bash', [path.join(dir, 'scripts', 'gate.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GATE_CHEAP_CMD: 'true',
      GATE_FULL_CMD: 'true',
      GATE_LOG_DIR: path.join(dir, '.gate-logs'),
      GATE_LOCK_DIR: path.join(dir, '.gate-lock'),
      COS_JOURNAL: path.join(dir, '.cos', 'journal.jsonl'),
      ...env,
    },
  });
}

function journal(dir) {
  const file = path.join(dir, '.cos', 'journal.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('scaffold gate: the cheap tier exits 2 and journals a cheap, lock-free run', () => {
  const dir = tempRepo();
  try {
    const result = run(dir, { GATE_TESTS: '0', COS_RUNTIME: 'claude-code', COS_SESSION: 's-1' });
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    const events = journal(dir);
    assert.equal(events.length, 1, JSON.stringify(events));
    assert.equal(events[0].event, 'gate');
    assert.equal(events[0].tier, 'cheap');
    assert.equal(events[0].exit, 2);
    assert.equal(events[0].lock, 'none');
    assert.equal(events[0].runtime, 'claude-code');
    assert.equal(events[0].session, 's-1');
    assert.match(events[0].sha, /^[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold gate: the full tier exits 0 and journals the acquired lock', () => {
  const dir = tempRepo();
  try {
    const result = run(dir, { GATE_TESTS: '1', COS_RUNTIME: 'dsh', COS_SESSION: 's-2' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const events = journal(dir);
    assert.equal(events.length, 1, JSON.stringify(events));
    assert.equal(events[0].tier, 'full');
    assert.equal(events[0].exit, 0);
    assert.equal(events[0].lock, 'acquired');
    assert.equal(events[0].runtime, 'dsh');
    assert.ok(!fs.existsSync(path.join(dir, '.gate-lock')), 'the trap must release the lock');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold gate: a refusal is VOID, exit 9, and still journaled', () => {
  const dir = tempRepo();
  try {
    const lock = path.join(dir, '.gate-lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), `pid=${process.pid}\nstarted=2026-01-01T00:00:00Z\ntier=full\nrepo=${dir}\n`);
    const result = run(dir, { GATE_TESTS: '1' });
    assert.equal(result.status, 9, `${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes('REFUSED'), result.stdout);
    const events = journal(dir);
    assert.equal(events.length, 1, JSON.stringify(events));
    assert.equal(events[0].exit, 9);
    assert.equal(events[0].lock, 'refused');
    assert.equal(events[0].tier, 'full');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold gate: a Claude Code run inherits the runtime session, not the DSH parent', () => {
  const dir = tempRepo();
  try {
    const result = run(dir, {
      GATE_TESTS: '0',
      CLAUDECODE: '1',
      CLAUDE_SESSION_ID: 'cc-1',
      DSH_SESSION_ID: 'dsh-parent',
    });
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    const events = journal(dir);
    assert.equal(events[0].runtime, 'claude-code');
    assert.equal(events[0].session, 'cc-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
