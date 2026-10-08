// Tests for tools/repeated-code/find-repeated-code.mjs
//
// Pure helpers are unit-tested; the scanner runs end-to-end against a throwaway
// fs.mkdtempSync fixture (never over src/), so this stays fast and independent of
// any real codebase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { tokenize, maskCode } from '../duplicate-candidates/find-duplicate-candidates.mjs';
import {
  idiomShape,
  fnv,
  shingles,
  minhash,
  findBodyClones,
  findIdioms,
  scan,
  renderMarkdown,
  BANDS,
  ROWS,
} from './find-repeated-code.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'find-repeated-code.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('idiomShape keeps property names and globals, erases locals and numbers', () => {
  const { norm, names } = idiomShape(tokenize(maskCode('const d = Math.hypot(a.x - b.x, 3);')));
  assert.deepEqual(norm, ['const', 'ID', '=', 'Math', '.', 'hypot', '(', 'ID', '.', 'x', '-', 'ID', '.', 'x', ',', 'NUM', ')', ';']);
  assert.deepEqual(names.filter(Boolean), ['Math', '.hypot', '.x', '.x']);
});

test('fnv is a stable 32-bit hash', () => {
  assert.equal(fnv(''), 0x811c9dc5);
  assert.equal(fnv('abc'), fnv('abc'));
  assert.notEqual(fnv('abc'), fnv('abd'));
  assert.ok(fnv('anything') >= 0 && fnv('anything') <= 0xffffffff);
});

test('minhash agrees with itself and its length is BANDS x ROWS', () => {
  const toks = tokenize(maskCode('{ let s = 0; for (const v of xs) { s += v * v; } return Math.sqrt(s); }'));
  const set = shingles(toks);
  assert.ok(set.size > 0);
  const sig = minhash(set);
  assert.equal(sig.length, BANDS * ROWS);
  assert.deepEqual(minhash(new Set(set)), sig);
});

// ---------------------------------------------------------------------------
// Body clones
// ---------------------------------------------------------------------------

const BODY = (n) => `{
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const dx = pts[i].x - pts[i - 1].x;
    const dz = pts[i].z - pts[i - 1].z;
    total += Math.sqrt(dx * dx + dz * dz) * ${n};
  }
  return total;
}`;

test('findBodyClones pairs the same body under different names and skips small or nested ones', () => {
  const fn = (name, file, line, src) => ({ name, file, line, endLine: line + 8, size: tokenize(maskCode(src)).length, tokens: tokenize(maskCode(src)) });
  const fns = [
    fn('routeLength', 'a.ts', 1, BODY(1)),
    fn('polyLen', 'b.ts', 1, BODY(2)),
    fn('tiny', 'c.ts', 1, '{ return 1; }'),
  ];
  const { clusters, stats } = findBodyClones(fns, { minBody: 20 });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].names, ['polyLen', 'routeLength']);
  assert.equal(clusters[0].sameName, false);
  assert.equal(stats.tooSmall, 1);

  // The same body nested inside itself (same file, overlapping lines) is no copy.
  const nested = findBodyClones([fn('outer', 'a.ts', 1, BODY(1)), fn('inner', 'a.ts', 3, BODY(1))], { minBody: 20 });
  assert.equal(nested.clusters.length, 0);
  assert.equal(nested.stats.nested, 1);
});

// ---------------------------------------------------------------------------
// Idioms
// ---------------------------------------------------------------------------

const IDIOM = (v) => `if (world.terrain.isWater(${v}.x, ${v}.z, 0.5) && world.bridgeDeck(${v}.x, ${v}.z) === -Infinity) continue;`;
const GENERIC = (v) => `const dx = ${v}.x - b.x, dz = ${v}.z - b.z, dy = ${v}.y - b.y; const d = dx * dx + dz * dz + dy * dy;`;

function idiomSources() {
  // Every file says something else around the shared lines, so df stays informative.
  return [
    { file: 'a.ts', source: `function pickA(p) { a1.alpha(); ${IDIOM('p')} ${GENERIC('p')} }` },
    { file: 'b.ts', source: `function pickB(q) { b1.beta(); ${IDIOM('q')} ${GENERIC('q')} }` },
    { file: 'c.ts', source: `function pickC(r) { c1.gamma(); ${IDIOM('r')} ${GENERIC('r')} }` },
    { file: 'd.ts', source: 'function other() { return d1.delta(); }' },
    { file: 'e.ts', source: 'function more() { return e1.epsilon(); }' },
    { file: 'f.ts', source: 'function yetMore(v) { return v.x + v.y + v.z; }' },
    // Unrelated files: names are only specific relative to a codebase that does other things.
    ...Array.from({ length: 14 }, (_, i) => ({ file: `z${String(i).padStart(2, '0')}.ts`, source: `function filler${i}(o) { return o.k${i}(); }` })),
  ];
}

test('findIdioms finds an inline snippet pasted into three files, with its names', () => {
  const { idioms } = findIdioms(idiomSources(), { window: 12, minFiles: 3, minInfo: 6 });
  assert.ok(idioms.length >= 1, 'the water idiom is reported');
  const top = idioms[0];
  assert.equal(top.files, 3);
  assert.ok(top.names.includes('.isWater') && top.names.includes('.bridgeDeck'));
  assert.deepEqual(top.at.map((a) => a.file), ['a.ts', 'b.ts', 'c.ts']);
  assert.ok(top.excerpt.join('\n').includes('isWater'));
});

test('findIdioms filters generic glue but counts it and keeps it recoverable', () => {
  const generic = [0, 1, 2, 3].map((i) => ({ file: `g${i}.ts`, source: `function f${i}(a) { ${GENERIC('a')} return d; }` }));
  const strict = findIdioms(generic, { window: 12, minFiles: 3, minInfo: 6 });
  assert.equal(strict.idioms.length, 0);
  assert.ok(strict.stats.lowInfo >= 1);
  assert.equal(strict.filtered.length, strict.stats.lowInfo);
  const loose = findIdioms(generic, { window: 12, minFiles: 3, minInfo: 0 });
  assert.ok(loose.idioms.length >= 1);
});

test('findIdioms reports a shifted variant of a reported run only once', () => {
  const { idioms, stats } = findIdioms(idiomSources(), { window: 8, minFiles: 3, minInfo: 0 });
  const withWater = idioms.filter((d) => d.names.includes('.isWater'));
  assert.equal(withWater.length, 1);
  assert.ok(stats.absorbed >= 1);
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repeated-code-'));
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(src, 'route.ts'), `export function routeLength(pts) ${BODY(1)}\n`);
  fs.writeFileSync(path.join(src, 'deep', 'poly.ts'), `export const polyLen = (pts) => ${BODY(1)};\n`);
  for (const [i, s] of idiomSources().entries()) fs.writeFileSync(path.join(src, `idiom${i}.ts`), `${s.source}\n`);
  fs.writeFileSync(path.join(src, 'broken.ts'), 'function ( { ]');
  return { dir, src };
}

test('scan finds both kinds over a real tree', () => {
  const { dir, src } = fixture();
  try {
    const r = scan(src, { displayBase: dir, minBody: 20, window: 12 });
    const diff = r.clones.clusters.filter((c) => !c.sameName);
    assert.ok(diff.some((c) => c.names.includes('routeLength') && c.names.includes('polyLen')));
    assert.ok(r.idioms.idioms.some((d) => d.names.includes('.isWater')));
    const md = renderMarkdown(r);
    assert.ok(md.includes('Body clones under different names'));
    assert.ok(md.includes('Filtered: generic idioms'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 0, writes the report, and two runs are byte-identical', () => {
  const { dir, src } = fixture();
  try {
    const run = (n) => spawnSync(process.execPath, [TOOL, '--src', src, '--report', path.join(dir, `r${n}.md`), '--min-body', '20', '--window', '12'], { encoding: 'utf8' });
    const a = run(1), b = run(2);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.match(a.stdout, /NOT verdicts/);
    assert.match(a.stdout, /routeLength/);
    assert.equal(fs.readFileSync(path.join(dir, 'r1.md'), 'utf8'), fs.readFileSync(path.join(dir, 'r2.md'), 'utf8'));
    assert.equal(a.stdout.replace(/r1\.md/g, ''), b.stdout.replace(/r2\.md/g, ''));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects an unknown flag with a non-zero exit', () => {
  const r = spawnSync(process.execPath, [TOOL, '--nope'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown argument/);
});
