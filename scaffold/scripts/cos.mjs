#!/usr/bin/env node
// cos.mjs — the project-side loader and record tool for the cross-tool contract.
//
// It reads the Claude Code files a project already owns (`.claude/commands/*.md`,
// `.claude/agents/*.md`), renders them for the harness at hand, and keeps the
// tool-neutral record (status, handoff, doctor, journal). It does not run the gate:
// the gate is `scripts/gate.sh`, because BOTH harnesses run that.
//
// Dependency-free. Node >= 24. See docs/CROSS-TOOL.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const SCRIPT = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT);
const argv = process.argv.slice(2);
const command = argv[0] || 'help';

function git(args, cwd = process.cwd()) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function resolveRoots() {
  const top = git(['rev-parse', '--show-toplevel']);
  const project = top || process.cwd();
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], project);
  const common = commonDir ? path.dirname(commonDir) : project;
  return { project, common };
}

const { project: PROJECT, common: COMMON } = resolveRoots();
const STATE = path.join(COMMON, '.cos');
const JOURNAL = path.join(STATE, 'journal.jsonl');

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return text;
  return text.slice(end + 5).replace(/^\n+/, '');
}

function markdownNames(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function loadFile(kind, name) {
  const dir = path.join(PROJECT, '.claude', kind);
  const file = path.join(dir, `${name}.md`);
  if (!fs.existsSync(file)) {
    const available = markdownNames(dir);
    fail(`no .claude/${kind}/${name}.md` +
      (available.length ? ` (available: ${available.join(', ')})` : ''));
  }
  return stripFrontmatter(fs.readFileSync(file, 'utf8')).trimEnd() + '\n';
}

function fail(message, code = 2) {
  process.stderr.write(`cos: ${message}\n`);
  process.exit(code);
}

function render(body, args) {
  let out = body.replaceAll('$ARGUMENTS', args.join(' '));
  args.forEach((value, index) => {
    out = out.replaceAll(`$${index + 1}`, value);
  });
  return out;
}

function runtime() {
  const forced = process.env.COS_RUNTIME;
  const forcedSession = process.env.COS_SESSION;
  // CLAUDE_PROJECT_DIR is set by the hook dispatcher in BOTH harnesses, so it is
  // not a runtime signal. CLAUDECODE / CLAUDE_SESSION_ID are Claude Code's own.
  const claude = process.env.CLAUDECODE || process.env.CLAUDE_SESSION_ID;
  const dsh = process.env.DSH_SESSION_ID;
  const name = forced || (claude ? 'claude-code' : dsh ? 'dsh' : 'unknown');
  // The session follows the runtime. A Claude Code session launched from a DSH
  // shell inherits DSH_SESSION_ID; it must not be filed under the DSH parent.
  const session = forcedSession
    || (claude
      ? (process.env.CLAUDE_SESSION_ID || process.env.CLAUDECODE_SESSION_ID || '')
      : (dsh || ''))
    || '';
  return { name, session: session || 'unknown' };
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockState() {
  const dir = path.join(COMMON, '.gate-lock');
  if (!fs.existsSync(dir)) return { state: 'free', pid: 0 };
  const line = readLines(path.join(dir, 'owner')).find((l) => l.startsWith('pid='));
  const pid = line ? Number(line.slice(4)) : 0;
  return { state: isAlive(pid) ? 'held' : 'stale', pid };
}

function journalEvents() {
  return readLines(JOURNAL).map((line) => {
    try { return JSON.parse(line); } catch { return { event: 'malformed' }; }
  });
}

function lastGate(events = journalEvents()) {
  const gates = events.filter((event) => event.event === 'gate');
  return gates.length ? gates[gates.length - 1] : null;
}

function headFacts() {
  const sha = git(['rev-parse', 'HEAD'], PROJECT);
  const short = sha ? git(['rev-parse', '--short', 'HEAD'], PROJECT) : 'none';
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], PROJECT) || 'none';
  const remote = git(['rev-parse', '--short', `origin/${branch}`], PROJECT) || 'none';
  return { sha, short, branch, remote };
}

function statusLines() {
  const { short, branch, remote } = headFacts();
  const lock = lockState();
  const events = journalEvents();
  const last = lastGate(events);
  const worktrees = git(['worktree', 'list', '--porcelain'], PROJECT)
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  const lastText = last
    ? `${last.exit}@${String(last.sha || '').slice(0, 7) || '?'}`
    : 'none';
  return {
    one: `repo=${path.basename(COMMON)} head=${short} remote=${remote} ` +
      `lock=${lock.state} last=${lastText} journal=${events.length}`,
    full: [
      `repo:      ${COMMON}`,
      `project:   ${PROJECT}`,
      `branch:    ${branch}`,
      `head:      ${short}`,
      `remote:    ${remote}`,
      `lock:      ${lock.state}${lock.pid ? ` (pid ${lock.pid})` : ''}`,
      `journal:   ${JOURNAL} (${events.length} events)`,
      `last gate: ${last ? `exit ${last.exit} at ${last.sha || '?'} (${last.tier || '?'}, ${last.runtime || '?'})` : 'none'}`,
      `worktrees: ${worktrees.length ? '' : 'none'}`,
      ...worktrees.map((wt) => `  - ${wt}`),
    ],
  };
}

function handoffDraft() {
  const { sha, short, branch } = headFacts();
  const last = lastGate();
  const by = runtime();
  const gateText = last
    ? `gate \`${last.exit}\` · \`<counts / peak>\``
    : '`none`';
  return `# Handoff — ${path.basename(COMMON)}

<!-- One screen, overwritten in place. The next session — DSH or Claude Code —
     reads this after AGENTS.md and docs/CROSS-TOOL.md. -->

- **by:** \`${by.name}/${by.session}\`
- **at:** \`${new Date().toISOString()}\`
- **branch / worktree:** \`${branch}\` · \`${PROJECT}\`
- **last verified:** \`${short}\` (${sha || 'no sha'}) · ${gateText}

## Done

- <fill: one line per landed change since the last handoff>

## In flight

- <fill: role · branch · worktree · what it owns · what it needs>

## Next action (one)

<fill: the single next step; name the role and the worktree. "Continue" is not a next action.>

## Open questions for the owner

- <fill: only decisions that are genuinely the owner's>

## Read first

- \`AGENTS.md\`
- \`docs/CROSS-TOOL.md\`
- <fill: the two files that carry this slice>
`;
}

function doctor() {
  const budgetFlag = argv.indexOf('--budget');
  const budget = budgetFlag !== -1 ? Number(argv[budgetFlag + 1]) : 12288;
  const rows = [];
  let failed = false;

  // The cross-tool contract's core files. The instruction file is checked below
  // because a project may use either filename.
  for (const rel of [
    'HANDOFF.md',
    'docs/CROSS-TOOL.md',
    'scripts/gate.sh',
    'scripts/cos.mjs',
    '.cos/hooks/session-start.sh',
    '.cos/hooks/pre-tool-use.sh',
    '.cos/hooks/stop.sh',
  ]) {
    const ok = fs.existsSync(path.join(PROJECT, rel));
    if (!ok) failed = true;
    rows.push(`${ok ? 'OK  ' : 'FAIL'} ${rel}`);
  }

  // A project may use EITHER instruction filename. Both harnesses read both
  // (Claude Code 2.1.x reads AGENTS.md too), so the contract must not force a
  // rename on a project that already has one. Two different files are the defect.
  const agents = path.join(PROJECT, 'AGENTS.md');
  const claude = path.join(PROJECT, 'CLAUDE.md');
  const hasAgents = fs.existsSync(agents);
  const hasClaude = fs.existsSync(claude);
  if (!hasAgents && !hasClaude) {
    failed = true;
    rows.push('FAIL instruction file: neither AGENTS.md nor CLAUDE.md');
  } else if (hasAgents && hasClaude) {
    const isLink = fs.lstatSync(claude).isSymbolicLink();
    const same = isLink || fs.readFileSync(claude, 'utf8') === fs.readFileSync(agents, 'utf8');
    if (!same) {
      failed = true;
      rows.push('FAIL two instruction files differ: AGENTS.md and CLAUDE.md — keep ONE');
    } else {
      rows.push(`OK   AGENTS.md + CLAUDE.md (${isLink ? 'symlinked' : 'identical'})`);
    }
  }
  const instruction = hasAgents ? agents : hasClaude ? claude : '';
  if (instruction) {
    const size = fs.statSync(instruction).size;
    const ok = size <= budget;
    if (!ok) failed = true;
    rows.push(`${ok ? 'OK  ' : 'FAIL'} ${path.basename(instruction)} ${size} bytes (budget ${budget})`);
  }

  // These are part of the Toolbox scaffold, not the cross-tool contract: a project
  // with its own command/agent conventions (a thin CLAUDE.md + PR flow) does not
  // need them. Missing is a warning, never a failure.
  for (const rel of ['.claude/commands/chief-of-staff.md', '.claude/agents/writer.md']) {
    const ok = fs.existsSync(path.join(PROJECT, rel));
    rows.push(`${ok ? 'OK  ' : 'WARN'} ${rel}${ok ? '' : ' (optional; the project may use its own)'}`);
  }

  const lock = lockState();
  rows.push(`${lock.state === 'held' ? 'WARN' : 'OK  '} gate lock: ${lock.state}${lock.pid ? ` (pid ${lock.pid})` : ''}`);

  const events = journalEvents();
  rows.push(`${events.length ? 'OK  ' : 'WARN'} journal: ${JOURNAL} (${events.length} events)`);

  for (const hook of ['session-start.sh', 'pre-tool-use.sh', 'stop.sh']) {
    const file = path.join(PROJECT, '.cos', 'hooks', hook);
    if (!fs.existsSync(file)) continue;
    const exec = Boolean(fs.statSync(file).mode & 0o111);
    rows.push(`${exec ? 'OK  ' : 'WARN'} .cos/hooks/${hook} ${exec ? 'executable' : 'is not executable'}`);
  }

  // The user-level hook layer is host configuration, not project law. Report it;
  // never fail the project for it.
  const userSettings = path.join(os.homedir(), '.claude', 'settings.json');
  if (fs.existsSync(userSettings)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(userSettings, 'utf8'));
      const hasHooks = parsed && typeof parsed === 'object' && parsed.hooks && Object.keys(parsed.hooks).length > 0;
      rows.push(`${hasHooks ? 'OK  ' : 'WARN'} user hook layer: ${userSettings}${hasHooks ? '' : ' has no hooks'}`);
    } catch {
      rows.push(`WARN user hook layer: ${userSettings} is not valid JSON`);
    }
  } else {
    rows.push(`WARN user hook layer: ${userSettings} not found (see docs/CROSS-TOOL.md)`);
  }

  process.stdout.write(`cos ${VERSION} doctor — ${PROJECT}\n\n${rows.join('\n')}\n`);
  process.exit(failed ? 1 : 0);
}

function copyFileSafe(src, dst, force) {
  if (!fs.existsSync(src)) return false;
  if (fs.existsSync(dst) && !force) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function copyDirSafe(src, dst, force) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSafe(from, to, force);
    else copyFileSafe(from, to, force);
  }
}

function portableDoc(text) {
  return text.replaceAll('../scaffold/', '../');
}

function init() {
  const targetArg = argv[1];
  if (!targetArg) fail('usage: cos init <target-dir> [--force]');
  const target = path.resolve(targetArg);
  const force = argv.includes('--force');
  const scaffold = path.resolve(SCRIPT_DIR, '..');
  const toolbox = path.resolve(scaffold, '..');

  if (!fs.existsSync(path.join(scaffold, 'AGENTS.md.template'))) {
    fail('init must run from the Toolbox scaffold (scaffold/scripts/cos.mjs)');
  }
  if (fs.existsSync(path.join(target, 'CLAUDE.md')) && !force) {
    fail(`${target}/CLAUDE.md already exists — this is a Claude Code-native project, ` +
      `not a greenfield one. Use minimal adoption (docs/CROSS-TOOL.md): add ` +
      `HANDOFF.md, scripts/gate.sh, scripts/cos.mjs and .cos/hooks, and keep CLAUDE.md. ` +
      `Do not create a second instruction file.`);
  }
  if (fs.existsSync(path.join(target, 'AGENTS.md')) && !force) {
    fail(`${target}/AGENTS.md already exists; pass --force to overwrite`);
  }
  fs.mkdirSync(target, { recursive: true });

  const written = [];
  const add = (src, dst) => { if (copyFileSafe(src, dst, force)) written.push(path.relative(target, dst)); };

  add(path.join(scaffold, 'AGENTS.md.template'), path.join(target, 'AGENTS.md'));
  add(path.join(scaffold, 'HANDOFF.md.template'), path.join(target, 'HANDOFF.md'));
  copyDirSafe(path.join(scaffold, '.claude'), path.join(target, '.claude'), force);
  copyDirSafe(path.join(scaffold, '.cos', 'hooks'), path.join(target, '.cos', 'hooks'), force);

  for (const script of ['gate.sh', 'board.sh', 'cos.mjs', 'cos-hook.mjs']) {
    add(path.join(scaffold, 'scripts', script), path.join(target, 'scripts', script));
  }

  const docs = [
    'BOARD.md',
    'DECISION-LEDGER.md',
    'SEAM-INDEX.md',
    'TESTING.md',
    'GATE.md',
    'BRIEF.md',
    'CROSS-TOOL.md',
    'TRAPS.md',
    'WAY-OF-WORKING.md',
  ];
  for (const doc of docs) {
    const src = path.join(toolbox, 'docs', doc);
    if (!fs.existsSync(src)) continue;
    const name = doc === 'SEAM-INDEX.md' ? 'ARCHITECTURE.md' : doc;
    const dst = path.join(target, 'docs', name);
    if (fs.existsSync(dst) && !force) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, portableDoc(fs.readFileSync(src, 'utf8')));
    written.push(path.relative(target, dst));
  }

  for (const dir of ['.cos', 'docs']) fs.mkdirSync(path.join(target, dir), { recursive: true });
  fs.writeFileSync(path.join(target, '.cos', 'version'), `cos ${VERSION}\n`);

  const gitignore = path.join(target, '.gitignore');
  const lines = ['.gate-logs/', '.gate-lock/', 'worktrees/', '.cos/journal.jsonl', '.cos/worktrees', '.cos/root-session', '.cos/.stop-guard'];
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  const missing = lines.filter((line) => !current.split('\n').map((l) => l.trim()).includes(line));
  if (missing.length) {
    fs.appendFileSync(gitignore, `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    written.push('.gitignore');
  }

  for (const rel of ['scripts/gate.sh', 'scripts/board.sh', 'scripts/cos.mjs', 'scripts/cos-hook.mjs',
    '.cos/hooks/session-start.sh', '.cos/hooks/pre-tool-use.sh', '.cos/hooks/stop.sh']) {
    const file = path.join(target, rel);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
  }

  process.stdout.write(`cos init ${target}\n\nwrote ${written.length} files:\n` +
    written.map((rel) => `  ${rel}`).join('\n') + `

next:
  1. Fill the stack line and the binding rules in AGENTS.md.
  2. Set GATE_CHEAP_CMD / GATE_FULL_CMD in scripts/gate.sh (or the environment).
  3. git init, commit, and push once so the board reconciler can see a remote.
  4. Install the user-level hook layer once (docs/CROSS-TOOL.md, "Installation").
  5. Start a session and say:
     "Be my chief of staff. Read AGENTS.md, docs/CROSS-TOOL.md and HANDOFF.md."
`);
}

if (command === 'run') {
  const name = argv[1];
  if (!name) fail(`usage: cos run <command> [args...] (commands: ${markdownNames(path.join(PROJECT, '.claude', 'commands')).join(', ') || 'none'})`);
  process.stdout.write(render(loadFile('commands', name), argv.slice(2)));
  process.exit(0);
}

if (command === 'dispatch') {
  const name = argv[1];
  if (!name) fail(`usage: cos dispatch <agent> [task...] (agents: ${markdownNames(path.join(PROJECT, '.claude', 'agents')).join(', ') || 'none'})`);
  const body = loadFile('agents', name);
  const task = argv.slice(2).join(' ').trim();
  process.stdout.write(task ? `${body}\n# Task\n\n${task}\n` : body);
  process.exit(0);
}

if (command === 'status') {
  if (!git(['rev-parse', 'HEAD'], PROJECT)) {
    process.stderr.write('cos: CANNOT LOOK: not a git repository with a commit\n');
    process.exit(1);
  }
  const { one, full } = statusLines();
  process.stdout.write(argv.includes('--one-line') ? `${one}\n` : `${full.join('\n')}\n`);
  process.exit(0);
}

if (command === 'handoff') {
  const draft = handoffDraft();
  if (argv.includes('--write')) {
    const file = path.join(PROJECT, 'HANDOFF.md');
    fs.writeFileSync(file, draft);
    process.stdout.write(`wrote ${file} — fill every <fill> marker before committing.\n`);
  } else {
    process.stdout.write(draft);
  }
  process.exit(0);
}

if (command === 'worktree') {
  const action = argv[1];
  const file = path.join(STATE, 'worktrees');
  const rootSession = path.join(STATE, 'root-session');
  const list = readLines(file);
  if (action === 'list' || !action) {
    process.stdout.write(list.length ? `${list.join('\n')}\n` : 'no dispatched worktrees\n');
    process.exit(0);
  }
  if (action === 'clear') {
    for (const f of [file, rootSession, path.join(STATE, '.stop-guard')]) {
      try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    }
    process.stdout.write('cleared the dispatched worktrees and the root-session guard\n');
    process.exit(0);
  }
  const target = argv[2] ? path.resolve(PROJECT, argv[2]) : '';
  if (!target) fail('usage: cos worktree add|remove <absolute-path> | clear | list');
  if (action === 'add') {
    fs.mkdirSync(STATE, { recursive: true });
    if (!list.includes(target)) fs.appendFileSync(file, `${target}\n`);
    if (!fs.existsSync(rootSession)) {
      const { session } = runtime();
      if (session !== 'unknown') fs.writeFileSync(rootSession, `${session}\n`);
    }
    process.stdout.write(`worktree added: ${target}\n`);
    process.exit(0);
  }
  if (action === 'remove') {
    fs.writeFileSync(file, list.filter((entry) => entry !== target).map((entry) => `${entry}\n`).join(''));
    if (readLines(file).length === 0) {
      try { fs.rmSync(file, { force: true }); fs.rmSync(rootSession, { force: true }); } catch { /* best effort */ }
    }
    process.stdout.write(`worktree removed: ${target}\n`);
    process.exit(0);
  }
  fail(`unknown worktree action: ${action}`);
}

if (command === 'doctor') doctor();
if (command === 'version') {
  process.stdout.write(`cos ${VERSION}\n`);
  process.exit(0);
}
if (command === 'init') init();

process.stdout.write(`cos ${VERSION} — cross-tool loader and record

  cos run <command> [args...]     render .claude/commands/<name>.md
  cos dispatch <agent> [task...]  render .claude/agents/<name>.md
  cos status [--one-line]         git, lock, journal, worktrees
  cos handoff [--write]           draft or write HANDOFF.md
  cos worktree add|remove|clear|list
  cos doctor [--budget N]         required files, budget, lock, hooks
  cos init <dir> [--force]        copy the scaffold into a new project

The gate is scripts/gate.sh — both harnesses run it. See docs/CROSS-TOOL.md.
`);
