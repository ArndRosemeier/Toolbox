#!/usr/bin/env node
// cos-hook.mjs — the project-side hook logic shared by DSH and Claude Code.
//
// The user-level hook file calls one dispatcher, which runs
//   <project>/.cos/hooks/<event>.sh
// only when that file exists. These hooks read the same stdin JSON in both
// harnesses (the DSH bridge normalizes to the Claude Code payload), and no-op when
// the project has no cross-tool state.
//
// No dependencies. Node >= 24.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const COMMON = commonRoot(PROJECT);
const STATE = path.join(COMMON, '.cos');
const command = process.argv[2] || '';
const payload = parseStdin(await readStdin());

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function parseStdin(text) {
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function commonRoot(cwd) {
  try {
    const dir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.dirname(dir);
  } catch {
    return cwd;
  }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function inside(target, root) {
  const t = real(target);
  const r = real(root);
  return t === r || t.startsWith(r + path.sep);
}

function allow() { process.exit(0); }

function deny(tool, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n');
  process.exit(0);
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

if (command === 'session-start') {
  const handoff = path.join(PROJECT, 'HANDOFF.md');
  if (!fs.existsSync(handoff)) allow();
  const body = fs.readFileSync(handoff, 'utf8').split('\n').slice(0, 80).join('\n');
  let text = `=== HANDOFF (read this first) ===\n${body}\n`;
  try {
    const line = execFileSync('node', [path.join(PROJECT, 'scripts', 'cos.mjs'), 'status', '--one-line'], {
      cwd: PROJECT, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (line) text += `=== STATUS ===\n${line}\n`;
  } catch { /* the status line is useful, never required */ }
  // Structured output is what BOTH consumers read: the DSH bridge folds
  // `hookSpecificOutput.additionalContext` into the session, and Claude Code accepts
  // the same shape. Plain stdout would be visible to Claude Code but NOT injected by
  // the bridge.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  }) + '\n');
  allow();
}

if (command === 'pre-tool-use') {
  const worktrees = readLines(path.join(STATE, 'worktrees'));
  if (worktrees.length === 0) allow();

  const tool = String(payload.tool_name || '');
  if (!/^(write|edit|multiedit|notebookedit)$/i.test(tool)) allow();

  const input = payload.tool_input || {};
  const target = input.file_path || input.path || input.notebook_path;
  if (!target) allow();

  // The dispatcher's own session may write the main tree; a child may only write
  // inside a worktree the dispatcher recorded. An absent id is no evidence: allow.
  const rootSession = readLines(path.join(STATE, 'root-session'))[0] || '';
  const session = String(payload.session_id || '');
  if (rootSession && session && session === rootSession) allow();

  const cwd = payload.cwd || PROJECT;
  const resolved = path.resolve(cwd, target);
  if (worktrees.some((root) => inside(resolved, root))) allow();

  deny(tool, `Write outside the dispatched worktree(s): ${resolved}. ` +
    `Allowed: ${worktrees.join(', ')}. The main tree is not a writer's workspace.`);
}

if (command === 'stop') {
  let sha = '';
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: PROJECT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { allow(); }
  if (!sha) allow();

  // No contract state at all: this project is not using the cross-tool layer.
  if (!fs.existsSync(STATE)) allow();

  // A missing journal means no gate has ever run here — that is exactly the
  // ungated commit this hook exists to catch. Only an absent `.cos/` is a no-op.
  const journal = path.join(STATE, 'journal.jsonl');
  let gated = false;
  for (const line of readLines(journal)) {
    try {
      const event = JSON.parse(line);
      if (event.event === 'gate' && event.sha === sha && [0, 1, 2].includes(event.exit)) {
        gated = true;
        break;
      }
    } catch { /* a malformed line is not evidence; keep looking */ }
  }

  const guard = path.join(STATE, '.stop-guard');
  if (gated) {
    try { fs.rmSync(guard, { force: true }); } catch { /* best effort */ }
    allow();
  }

  const last = readLines(guard)[0] || '';
  if (last === sha) allow(); // one forced step per commit, never a loop
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(guard, sha + '\n');
  block(`Commit ${sha.slice(0, 7)} has no gate run in .cos/journal.jsonl. ` +
    `Run bash scripts/gate.sh (or the cheap tier) and record the result before stopping.`);
}

allow();
