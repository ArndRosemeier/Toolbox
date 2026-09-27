// Repo-level guard for the SHARED layer.
//
// The chief-of-staff role once pointed at one app's docs for its process — the
// coupling this guard exists to prevent. Anything that TRAVELS (the scaffold is
// copied into other projects) must carry no reference to a single app: no repo
// name, no project-specific script or path.
//
// docs/WAY-OF-WORKING.md is deliberately NOT checked: it may name Campaigner as a
// worked example. The scaffold, which is copied, may not.
//
// This lives outside tools/ on purpose. `tools/` is copied into other projects on
// its own, so a test there must never reach outside its own folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Repo names and project-specific strings that must never reach a portable file. */
const LEAKS = [
  'Campaigner',
  'FracVibe',
  'CivGlm',
  'Orion',
  'projects/Expert',
  'duplication:check',
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test('portability: the scaffold carries no source-project specifics', () => {
  const files = walk(path.join(ROOT, 'scaffold'));
  // A vacuous pass would be worse than no guard: assert the folder was really read.
  assert.ok(files.length >= 6, `expected the scaffold files, found ${files.length}`);

  for (const file of files) {
    const body = fs.readFileSync(file, 'utf8');
    for (const leak of LEAKS) {
      assert.ok(
        !body.includes(leak),
        `${path.relative(ROOT, file)} leaks a source-project reference: ${leak}`,
      );
    }
  }
});

test('portability: the scaffold names the shared doc, not an app', () => {
  const template = fs.readFileSync(path.join(ROOT, 'scaffold', 'AGENTS.md.template'), 'utf8');
  assert.ok(
    template.includes('WAY-OF-WORKING.md'),
    'the project-rules template must point a new project at the shared process doc',
  );
});
