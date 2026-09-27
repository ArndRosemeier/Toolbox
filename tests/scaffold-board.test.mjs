// A behavioral pin for the SCAFFOLD's reconciler.
//
// `scaffold/scripts/board.sh` is copied into new projects, so a defect here is inherited
// by every project that starts from this scaffold. This one was real: when the remote
// branch could not be resolved, the reconciler did not say "I cannot look" — it reported
// the RECORD as stale. The cause is that a bare `git rev-parse <unresolvable-ref>` echoes
// the ref back verbatim and exits 128 (the complaint goes to stderr), so a
// `2>/dev/null || true` capture is NON-EMPTY and the emptiness guard never fires.
//
// The portability guards cannot catch this: they read text, and this is behaviour. So the
// pin runs the script, in a throwaway repo with no such remote, and asserts the verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = path.join(ROOT, 'scaffold', 'scripts', 'board.sh');

/** A throwaway repo with one commit and NO remote at all. */
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-board-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Scaffold Test');
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'BOARD.md'), 'reconciled: 0000000\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  return dir;
}

test('scaffold board.sh: an unresolvable remote is CANNOT LOOK, never "the record is stale"', () => {
  const dir = tempRepo();
  try {
    const result = spawnSync('bash', [BOARD], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        BOARD_FILE: path.join(dir, 'docs', 'BOARD.md'),
        BOARD_REMOTE: 'no-such-remote',
      },
    });
    assert.equal(
      result.status,
      1,
      `expected exit 1, got ${result.status}:\n${result.stdout}${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('CANNOT LOOK'),
      `a check that cannot look must SAY SO:\n${result.stdout}`,
    );
    assert.ok(
      !result.stdout.includes('BOARD STALE'),
      `it must not blame the record for its own blindness:\n${result.stdout}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold board.sh: it is executable and carries both verdicts', () => {
  const source = fs.readFileSync(BOARD, 'utf8');
  assert.ok(source.includes('BOARD RECONCILED'), 'must be able to report a reconciled board');
  assert.ok(source.includes('BOARD STALE'), 'must be able to report a stale board');
  assert.ok(fs.statSync(BOARD).mode & 0o111, 'the scaffold script must carry the execute bit');
});
