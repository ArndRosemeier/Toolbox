// Repo-level guards for the SHARED layer.
//
// Two regressions this file exists for, both seen for real:
//
//  1. COUPLING. The chief-of-staff role pointed at one app's folder for its process
//     docs. Anything that TRAVELS — the docs and the scaffold are copied into other
//     projects — must carry no reference to a single app: no repo name, no
//     project-specific script or path.
//  2. THINNESS. `docs/` held ONE file while the process named several artifacts, so
//     the layer read as a single essay instead of a documented set.
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

/** The one file allowed to cite a worked example, and why. */
const MAY_CITE_AN_EXAMPLE = [path.join('docs', 'WAY-OF-WORKING.md')];

const PORTABLE_ROOTS = ['docs', 'scaffold'];

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

function portableFiles() {
  const files = [];
  for (const rel of PORTABLE_ROOTS) files.push(...walk(path.join(ROOT, rel)));
  return files.filter((f) => !MAY_CITE_AN_EXAMPLE.includes(path.relative(ROOT, f)));
}

test('portability: the docs and the scaffold carry no source-project specifics', () => {
  const files = portableFiles();
  // A vacuous pass would be worse than no guard: assert the layer was really read.
  assert.ok(files.length >= 10, `expected the shared layer's files, found ${files.length}`);

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

test('docs: the layer documents the process AND every durable artifact', () => {
  // The process, plus one document per artifact it names — a reader browsing docs/
  // must find the board, the ledger, the seam index, the testing doc, the gate and
  // the brief, not just one essay.
  const required = [
    'README.md',
    'WAY-OF-WORKING.md',
    'BOARD.md',
    'DECISION-LEDGER.md',
    'SEAM-INDEX.md',
    'TESTING.md',
    'GATE.md',
    'BRIEF.md',
  ];
  for (const doc of required) {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs', doc)), `docs/${doc} is missing`);
  }
});

test('docs: every doc named in the index exists', () => {
  // Keeps the index honest: a link to a doc that was renamed or deleted is a broken
  // pointer, which is exactly the kind of rot the process warns about.
  const index = fs.readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8');
  const linked = [...index.matchAll(/\]\(([A-Za-z0-9._-]+\.md)\)/g)].map((m) => m[1]);
  assert.ok(linked.length >= 6, `expected the index to link the docs, found ${linked.length}`);
  for (const target of new Set(linked)) {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'docs', target)),
      `docs/README.md links ${target}, which does not exist`,
    );
  }
});

test('scaffold: the project-rules template points at the shared doc, not an app', () => {
  const template = fs.readFileSync(path.join(ROOT, 'scaffold', 'AGENTS.md.template'), 'utf8');
  assert.ok(
    template.includes('WAY-OF-WORKING.md'),
    'the project-rules template must point a new project at the shared process doc',
  );
});
