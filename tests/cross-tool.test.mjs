// Behavioral pins for the CROSS-TOOL contract.
//
// These files are copied into every new project, so a defect here is inherited.
// The portability guard in shared-layer.test.mjs skips dot-directories, which is
// exactly where `.claude/` and `.cos/` live — so this file walks them explicitly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COS = path.join(ROOT, 'scaffold', 'scripts', 'cos.mjs');
const HOOK = path.join(ROOT, 'scaffold', 'scripts', 'cos-hook.mjs');

const LEAKS = ['Campaigner', 'FracVibe', 'CivGlm', 'Imager', 'Orion', 'projects/Expert'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function run(cwd, args, env = {}) {
  return spawnSync('node', [path.join(cwd, 'scripts', 'cos.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runHook(cwd, event, payload = {}) {
  return spawnSync('node', [path.join(cwd, 'scripts', 'cos-hook.mjs'), event], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
}

/** A scaffolded temp project with one commit. */
function initProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-project-'));
  const init = spawnSync('node', [COS, 'init', dir], { encoding: 'utf8' });
  assert.equal(init.status, 0, `cos init failed:\n${init.stdout}${init.stderr}`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Cross Tool Test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'scaffold');
  return dir;
}

test('cross-tool: the dot-directories are portable and complete', () => {
  const files = [
    ...walk(path.join(ROOT, 'scaffold', '.claude')),
    ...walk(path.join(ROOT, 'scaffold', '.cos')),
    COS,
    HOOK,
  ];
  assert.ok(files.length >= 10, `expected the cross-tool files, found ${files.length}`);
  for (const file of files) {
    const body = fs.readFileSync(file, 'utf8');
    for (const leak of LEAKS) {
      assert.ok(!body.includes(leak), `${path.relative(ROOT, file)} leaks ${leak}`);
    }
  }
  for (const rel of [
    '.claude/commands/chief-of-staff.md',
    '.claude/commands/reconcile.md',
    '.claude/commands/handoff.md',
    '.claude/agents/writer.md',
    '.claude/agents/reviewer.md',
    '.claude/agents/probe.md',
    '.cos/hooks/session-start.sh',
    '.cos/hooks/pre-tool-use.sh',
    '.cos/hooks/stop.sh',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, 'scaffold', rel)), `scaffold/${rel} is missing`);
  }
  const agents = fs.readFileSync(path.join(ROOT, 'scaffold', 'AGENTS.md.template'), 'utf8');
  assert.ok(agents.includes('docs/CROSS-TOOL.md'), 'the project rules must point at the cross-tool contract');
  const contract = fs.readFileSync(path.join(ROOT, 'docs', 'CROSS-TOOL.md'), 'utf8');
  assert.ok(contract.includes('Be my chief of staff'), 'the contract must carry the designation prompt');
});

test('cross-tool: cos init scaffolds a project, renames templates, and rewrites links', () => {
  const dir = initProject();
  try {
    for (const rel of [
      'AGENTS.md', 'HANDOFF.md', 'docs/CROSS-TOOL.md', 'docs/BOARD.md',
      'docs/ARCHITECTURE.md', 'docs/GATE.md', 'scripts/gate.sh', 'scripts/cos.mjs',
      'scripts/cos-hook.mjs', '.claude/commands/chief-of-staff.md',
      '.claude/agents/writer.md', '.cos/hooks/session-start.sh',
    ]) {
      assert.ok(fs.existsSync(path.join(dir, rel)), `${rel} was not scaffolded`);
    }
    const gateDoc = fs.readFileSync(path.join(dir, 'docs', 'GATE.md'), 'utf8');
    assert.ok(gateDoc.includes('../scripts/gate.sh'), 'the copied gate doc must point at the project script');
    assert.ok(!gateDoc.includes('../scaffold/'), 'the copied docs must not point back into the Toolbox scaffold');
    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(ignore.includes('.cos/journal.jsonl'), 'the journal must be gitignored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-tool: run and dispatch render the Claude Code files without frontmatter', () => {
  const dir = initProject();
  try {
    const command = run(dir, ['run', 'reconcile']);
    assert.equal(command.status, 0, command.stderr);
    assert.ok(command.stdout.includes("Reconcile the project's state"), command.stdout);
    assert.ok(!command.stdout.startsWith('---'), 'frontmatter must not reach the prompt');

    const agent = run(dir, ['dispatch', 'writer', 'brief text']);
    assert.equal(agent.status, 0, agent.stderr);
    assert.ok(agent.stdout.includes('You are a **WRITER**'), agent.stdout);
    assert.ok(agent.stdout.includes('# Task\n\nbrief text'), agent.stdout);

    const missing = run(dir, ['run', 'no-such-command']);
    assert.equal(missing.status, 2);
    assert.ok(missing.stderr.includes('available:'), missing.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-tool: status is one line, and doctor FAILs on a missing file or a fat AGENTS.md', () => {
  const dir = initProject();
  try {
    const status = run(dir, ['status', '--one-line']);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^repo=\S+ head=\S+ remote=\S+ lock=\S+ last=\S+ journal=\d+$/m);

    const doctor = run(dir, ['doctor']);
    assert.equal(doctor.status, 0, doctor.stdout);
    assert.ok(!doctor.stdout.includes('FAIL'), doctor.stdout);

    const fat = run(dir, ['doctor', '--budget', '10']);
    assert.equal(fat.status, 1, fat.stdout);
    assert.ok(fat.stdout.includes('FAIL AGENTS.md'), fat.stdout);

    fs.rmSync(path.join(dir, 'HANDOFF.md'));
    const missing = run(dir, ['doctor']);
    assert.equal(missing.status, 1, missing.stdout);
    assert.ok(missing.stdout.includes('FAIL HANDOFF.md'), missing.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-tool: handoff drafts the baton and can write it', () => {
  const dir = initProject();
  try {
    const draft = run(dir, ['handoff'], { COS_RUNTIME: 'claude-code', COS_SESSION: 's-1' });
    assert.equal(draft.status, 0, draft.stderr);
    assert.ok(draft.stdout.includes('# Handoff'), draft.stdout);
    assert.ok(draft.stdout.includes('claude-code/s-1'), draft.stdout);
    assert.ok(draft.stdout.includes('Next action (one)'), draft.stdout);

    const inherited = run(dir, ['handoff'], {
      CLAUDECODE: '1',
      CLAUDE_SESSION_ID: 'cc-1',
      DSH_SESSION_ID: 'dsh-parent',
    });
    assert.ok(inherited.stdout.includes('claude-code/cc-1'), inherited.stdout);

    const written = run(dir, ['handoff', '--write']);
    assert.equal(written.status, 0, written.stderr);
    assert.ok(fs.readFileSync(path.join(dir, 'HANDOFF.md'), 'utf8').includes('<fill'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-tool: the worktree guard denies outside, allows inside, and spares the root session', () => {
  const dir = initProject();
  try {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-wt-'));
    const added = run(dir, ['worktree', 'add', wt]);
    assert.equal(added.status, 0, added.stderr);

    const outside = runHook(dir, 'pre-tool-use', {
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'main-tree.ts') },
      cwd: dir,
      session_id: 'child',
    });
    const denied = JSON.parse(outside.stdout);
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');

    const inside = runHook(dir, 'pre-tool-use', {
      tool_name: 'write',
      tool_input: { file_path: path.join(wt, 'ok.ts') },
      cwd: dir,
      session_id: 'child',
    });
    assert.equal(inside.stdout.trim(), '');

    fs.writeFileSync(path.join(dir, '.cos', 'root-session'), 'root\n');
    const root = runHook(dir, 'pre-tool-use', {
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'docs', 'BOARD.md') },
      cwd: dir,
      session_id: 'root',
    });
    assert.equal(root.stdout.trim(), '', 'the dispatcher may write the main tree');

    run(dir, ['worktree', 'clear']);
    const cleared = runHook(dir, 'pre-tool-use', {
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'anything.ts') },
      cwd: dir,
      session_id: 'child',
    });
    assert.equal(cleared.stdout.trim(), '', 'no dispatched worktree means no guard');
    fs.rmSync(wt, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-tool: the stop hook blocks once per ungated commit, then self-limits', () => {
  const dir = initProject();
  try {
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    const first = runHook(dir, 'stop', { session_id: 'child' });
    const blocked = JSON.parse(first.stdout);
    assert.equal(blocked.decision, 'block');
    assert.ok(blocked.reason.includes(sha.slice(0, 7)), blocked.reason);

    const second = runHook(dir, 'stop', { session_id: 'child' });
    assert.equal(second.stdout.trim(), '', 'one forced step per sha, never a loop');

    fs.mkdirSync(path.join(dir, '.cos'), { recursive: true });
    fs.appendFileSync(
      path.join(dir, '.cos', 'journal.jsonl'),
      `${JSON.stringify({ event: 'gate', sha, exit: 0 })}\n`,
    );
    const gated = runHook(dir, 'stop', { session_id: 'child' });
    assert.equal(gated.stdout.trim(), '');
    assert.ok(!fs.existsSync(path.join(dir, '.cos', '.stop-guard')), 'the guard is cleared once gated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-tool: SessionStart injects the handoff and the status line', () => {
  const dir = initProject();
  try {
    const start = runHook(dir, 'session-start', {});
    assert.equal(start.status, 0, start.stderr);
    assert.ok(start.stdout.includes('=== HANDOFF'), start.stdout);
    assert.ok(start.stdout.includes('=== STATUS'), start.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
