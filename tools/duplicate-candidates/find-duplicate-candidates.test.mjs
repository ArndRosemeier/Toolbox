// Tests for tools/duplicate-candidates/find-duplicate-candidates.mjs
//
// Policy: new work ships with a test. Pure helpers are unit-tested here and the
// scanner is exercised end-to-end against a throwaway fs.mkdtempSync fixture
// (never over src/, so this stays fast and independent of the real codebase).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  maskCode,
  tokenize,
  extractFunctions,
  groupCandidates,
  normaliseName,
  splitNameTokens,
  stripAffixes,
  nearMatch,
  levenshtein,
  shape,
  jaccard,
  compareBodies,
  newPruneStats,
  DEFAULT_IGNORED_NAMES,
  resolveIgnoreList,
  toIgnoreSet,
  isUbiquitousPair,
  DEDUP_STRATEGIES,
  DEDUP_CAVEAT,
  DEFAULT_EXTENSIONS,
  resolveExtensions,
  normaliseExtensions,
  skipSuffixesFor,
} from './find-duplicate-candidates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'find-duplicate-candidates.mjs');

// ---------------------------------------------------------------------------
// Name helpers
// ---------------------------------------------------------------------------

test('normaliseName lowercases and drops _ and $', () => {
  assert.equal(normaliseName('addLogEntry'), 'addlogentry');
  assert.equal(normaliseName('add_log_entry'), 'addlogentry');
  assert.equal(normaliseName('AddLogEntry'), 'addlogentry');
  assert.equal(normaliseName('$foo_bar'), 'foobar');
  assert.equal(normaliseName('add_log_entry'), normaliseName('AddLogEntry'));
});

test('splitNameTokens splits camelCase, snake_case, SCREAMING_CASE and digits', () => {
  assert.deepEqual(splitNameTokens('addLogEntry'), ['add', 'log', 'entry']);
  assert.deepEqual(splitNameTokens('AddLogEntry'), ['add', 'log', 'entry']);
  assert.deepEqual(splitNameTokens('add_log_entry'), ['add', 'log', 'entry']);
  assert.deepEqual(splitNameTokens('parseHTMLString'), ['parse', 'html', 'string']);
  assert.deepEqual(splitNameTokens('MAX_SIZE'), ['max', 'size']);
  assert.deepEqual(splitNameTokens('sha256Hash'), ['sha', '256', 'hash']);
});

test('stripAffixes removes common affixes and never returns empty', () => {
  assert.deepEqual(stripAffixes(['handle', 'save']), ['save']);
  assert.deepEqual(stripAffixes(['get', 'user', 'profile']), ['user', 'profile']);
  assert.deepEqual(stripAffixes(['render', 'list', 'items']), ['list', 'items']);
  assert.deepEqual(stripAffixes(['load']), ['load']);
  assert.deepEqual(stripAffixes(['init']), ['init']);
});

test('nearMatch links affix variants and tiny edits, not unrelated names', () => {
  assert.ok(nearMatch('handleSave', 'save'));
  assert.ok(nearMatch('getUserProfile', 'userProfile'));
  assert.ok(nearMatch('getUserProfile', 'getUserProfiles'));
  assert.ok(nearMatch('handleSave', 'handleSaved'));
  assert.ok(!nearMatch('render', 'persistDatabase'));
  assert.ok(levenshtein('kitten', 'sitting', 5) === 3);
  assert.ok(levenshtein('abc', 'abc') === 0);
});

// ---------------------------------------------------------------------------
// Masking, tokenising, shapes
// ---------------------------------------------------------------------------

test('maskCode removes identifiers inside strings, templates and comments', () => {
  const src = [
    'const keep = "fakeFromString()"; // fakeFromComment()',
    '/* fakeFromBlock() */ const also = `fakeFromTemplate()`;',
    'const re = /fakeFromRegex\\(\\)/;',
    'const q = "it\'s still a string";',
    'const t = `outer ${ fakeFromTemplateExpr() } end`;',
    '',
  ].join('\n');
  const values = tokenize(maskCode(src)).map((t) => t.v);
  for (const fake of [
    'fakeFromString',
    'fakeFromComment',
    'fakeFromBlock',
    'fakeFromTemplate',
    'fakeFromRegex',
    'fakeFromTemplateExpr',
  ]) {
    assert.ok(!values.includes(fake), `${fake} leaked out of a literal/comment`);
  }
  assert.ok(values.includes('keep'));
  assert.ok(values.includes('also'));
  assert.ok(values.includes('re'));
});

test('shape replaces identifiers while punctuation survives', () => {
  const a = tokenize(maskCode('a.b(c)'));
  const b = tokenize(maskCode('x.y(z)'));
  assert.deepEqual(shape(a), ['ID', '.', 'ID', '(', 'ID', ')']);
  assert.deepEqual(shape(a), shape(b));
});

test('jaccard is a set-based similarity in [0,1]', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(['a', 'b'], ['c', 'd']), 0);
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  assert.equal(jaccard([], []), 0);
});

// ---------------------------------------------------------------------------
// Extraction forms
// ---------------------------------------------------------------------------

test('extractFunctions covers declarations, methods, arrows and accessors', () => {
  const src = [
    'export async function alpha(a: number): Promise<number> { return a; }',
    'class C {',
    '  private beta(x: number) { return x; }',
    '  get gamma() { return 1; }',
    '  set gamma(v) { this.v = v; }',
    '}',
    'export const delta = (x: number): number => { return x + 1; };',
    'const epsilon = async function () { return 2; };',
    'const zeta = x => x * 2;',
    'const eta = function namedInner() { return 3; };',
    '',
  ].join('\n');
  const names = extractFunctions(src).map((f) => f.name);
  for (const expected of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'namedInner']) {
    assert.ok(names.includes(expected), `missing extracted name: ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// Aggressive body-evidence pruning (the early exits must be REAL)
// ---------------------------------------------------------------------------

test('prune(size): wildly different bodies are ruled out WITHOUT tokenising', () => {
  const stats = newPruneStats();
  const accesses = { count: 0 };
  const lazy = (size) => ({
    size,
    _shapeSet: null,
    get tokens() {
      accesses.count += 1;
      return [];
    },
  });

  const result = compareBodies(lazy(10), lazy(400), { stats });

  assert.equal(result.status, 'ruled-out-size');
  assert.equal(result.reason, 'size');
  assert.equal(stats.prunedSize, 1);
  assert.equal(stats.shapeComputations, 0, 'no shape set may be built for a size prune');
  assert.equal(accesses.count, 0, 'bodies must not be tokenised for a size prune');
  assert.equal(stats.compared + stats.confirmed + stats.prunedDisjoint, 0);
});

test('prune(disjoint): disjoint token sets bail before a full intersection walk', () => {
  const stats = newPruneStats();
  const mk = (values) => ({
    size: values.length,
    _shapeSet: null,
    tokens: values.map((v) => ({ v, kind: 'punct', line: 1 })),
  });
  const a = mk(['(', ')', '{', '}', '[', ']', ';', ',', '.', ':']);
  const b = mk(['<', '>', '+', '-', '*', '/', '%', '=', '!', '?']);

  const result = compareBodies(a, b, { stats });

  assert.equal(result.status, 'ruled-out-disjoint');
  assert.equal(result.reason, 'disjoint');
  assert.equal(stats.prunedDisjoint, 1);
  assert.ok(result.examined > 0, 'the walk must have started');
  assert.ok(
    result.examined < 10,
    `expected a partial walk (< 10 tokens), examined=${result.examined}`,
  );
});

test('prune(confirmed): identical bodies confirm early instead of finishing', () => {
  const stats = newPruneStats();
  const tokens = ['(', ')', '{', '}', '[', ']', ';', ',', '.', ':'].map((v) => ({
    v,
    kind: 'punct',
    line: 1,
  }));
  const a = { size: tokens.length, _shapeSet: null, tokens };
  const b = { size: tokens.length, _shapeSet: null, tokens: tokens.slice() };

  const result = compareBodies(a, b, { stats });

  assert.equal(result.status, 'confirmed');
  assert.equal(result.reason, 'confirmed');
  assert.equal(stats.confirmed, 1);
  assert.equal(result.simIsLowerBound, true);
  assert.ok(result.sim >= 0.6, `lower bound should clear the confirm floor, got ${result.sim}`);
  assert.ok(result.examined < 10, `expected an early stop, examined=${result.examined}`);
});

test('compare: partially overlapping bodies are fully compared with an exact sim', () => {
  const stats = newPruneStats();
  const mk = (values) => ({
    size: values.length,
    _shapeSet: null,
    tokens: values.map((v) => ({ v, kind: 'punct', line: 1 })),
  });
  const a = mk(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  const b = mk(['a', 'b', 'c', 'd', 'e', 'k', 'l', 'm', 'n', 'o']);

  const result = compareBodies(a, b, { stats });

  assert.equal(result.status, 'compared');
  assert.equal(stats.compared, 1);
  assert.ok(Math.abs(result.sim - 1 / 3) < 0.01, `expected ~0.33, got ${result.sim}`);
  assert.equal(result.simIsLowerBound, undefined);
});

test('groupCandidates prune counters account for every candidate pair', () => {
  const mkFn = (name, file, line, values) => ({
    name,
    file,
    line,
    kind: 'function',
    size: values.length,
    tokens: values.map((v) => ({ v, kind: 'punct', line: 1 })),
    _shapeSet: null,
  });
  const functions = [
    mkFn('shared', 'src/a.ts', 1, ['a', 'b', 'c', 'd', 'e', 'f']),
    mkFn('shared', 'src/b.ts', 2, ['a', 'b', 'c', 'd', 'e', 'f']),
    mkFn('other', 'src/c.ts', 3, ['x']),
  ];

  const tiers = groupCandidates(functions);
  const total = tiers.tier1.length + tiers.tier2.length + tiers.tier3.length;
  const accounted =
    tiers.stats.compared +
    tiers.stats.confirmed +
    tiers.stats.prunedSize +
    tiers.stats.prunedDisjoint;

  assert.equal(tiers.tier1.length, 1, 'the two same-named functions form one tier-1 pair');
  assert.equal(tiers.stats.pairs, total);
  assert.equal(accounted, total, 'every comparison must end in exactly one bucket');
});

// ---------------------------------------------------------------------------
// Ubiquitous-name filter (auditable; never silently drops)
// ---------------------------------------------------------------------------

const mkFn = (name, file, line, values = ['a', 'b', 'c', 'd']) => ({
  name,
  file,
  line,
  kind: 'function',
  size: values.length,
  tokens: values.map((v) => ({ v, kind: 'punct', line: 1 })),
  _shapeSet: null,
});

test('ubiquitous filter: constructor is excluded by default but counted', () => {
  const functions = [
    mkFn('constructor', 'src/a.ts', 1),
    mkFn('constructor', 'src/b.ts', 2),
    mkFn('sharedThing', 'src/c.ts', 3),
    mkFn('sharedThing', 'src/d.ts', 4),
  ];

  const filtered = groupCandidates(functions);
  assert.equal(filtered.tier1.length, 1, 'only sharedThing stays in tier 1');
  assert.equal(filtered.tier1[0].a.name, 'sharedThing');
  assert.equal(filtered.ignoredTotal, 1, 'the constructor pair is counted, not dropped');
  assert.equal(filtered.ignored.length, 1);
  assert.equal(filtered.ignored[0].tier, 1);
  assert.equal(filtered.ignoredByName.get('constructor'), 1);
  // Still compared (evidence computed) so the report entry is complete.
  assert.notEqual(filtered.ignored[0].status, 'pending');
});

test('ubiquitous filter: --no-ignore brings ignored pairs back', () => {
  const functions = [
    mkFn('constructor', 'src/a.ts', 1),
    mkFn('constructor', 'src/b.ts', 2),
    mkFn('sharedThing', 'src/c.ts', 3),
    mkFn('sharedThing', 'src/d.ts', 4),
  ];

  const unfiltered = groupCandidates(functions, { ignoreList: [] });
  assert.equal(unfiltered.tier1.length, 2, 'constructor returns to tier 1');
  assert.equal(unfiltered.ignoredTotal, 0);
});

test('ubiquitous filter: --ignore replaces the default list', () => {
  const functions = [
    mkFn('constructor', 'src/a.ts', 1),
    mkFn('constructor', 'src/b.ts', 2),
    mkFn('sharedThing', 'src/c.ts', 3),
    mkFn('sharedThing', 'src/d.ts', 4),
  ];

  const replaced = groupCandidates(functions, { ignoreList: ['sharedThing'] });
  assert.equal(replaced.ignoredTotal, 1);
  assert.equal(replaced.ignoredByName.get('sharedThing'), 1);
  assert.ok(
    replaced.tier1.some((p) => p.a.name === 'constructor'),
    'constructor is no longer ignored when the list is replaced',
  );
});

test('isUbiquitousPair ignores only when EVERY name is boilerplate', () => {
  const set = toIgnoreSet(['open']);
  assert.equal(isUbiquitousPair({ a: { name: 'open' }, b: { name: 'open' } }, set), true);
  assert.equal(isUbiquitousPair({ a: { name: 'open' }, b: { name: 'openDocument' } }, set), false);
  assert.equal(isUbiquitousPair({ a: { name: 'open' }, b: { name: 'open' } }, new Set()), false);
});

test('resolveIgnoreList: default, --ignore replacement and --no-ignore', () => {
  assert.ok(DEFAULT_IGNORED_NAMES.includes('constructor'));
  assert.ok(DEFAULT_IGNORED_NAMES.includes('render'));
  assert.ok(resolveIgnoreList({}).includes('constructor'));
  assert.deepEqual(resolveIgnoreList({ ignore: 'foo, bar' }), ['foo', 'bar']);
  assert.deepEqual(resolveIgnoreList({ noIgnore: true }), []);
  assert.deepEqual(resolveIgnoreList({ ignore: 'foo', noIgnore: true }), []);
});

// ---------------------------------------------------------------------------
// End-to-end over a throwaway fixture directory
// ---------------------------------------------------------------------------

test('end-to-end: fixture directory reports tier 1 and ignores string/comment names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcand-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      [
        '// fakeFromComment() must never be reported',
        'export function sharedThing(value: number): number {',
        '  const label = "fakeFromString()";',
        '  return value + 1;',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(srcDir, 'b.ts'),
      [
        'export async function sharedThing(value: number): Promise<number> {',
        '  const label = `fakeFromTemplate()`;',
        '  return value + 2;',
        '}',
        'export function addLogEntry(x: string) { return x; }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(srcDir, 'c.ts'),
      'export function add_log_entry(x: string) { return x.trim(); }\n',
    );
    // Must be skipped: declaration files and test files.
    fs.writeFileSync(path.join(srcDir, 'ignored.d.ts'), 'export function sharedThing(): void;\n');
    fs.writeFileSync(
      path.join(srcDir, 'ignored.test.ts'),
      'export function sharedThing(): void {}\n',
    );

    const report = path.join(dir, 'reports', 'out.md');
    const run = spawnSync(
      process.execPath,
      [TOOL, '--src', srcDir, '--report', report],
      { cwd: dir, encoding: 'utf8' },
    );

    assert.equal(run.status, 0, `scanner must exit 0; stderr: ${run.stderr}`);
    const stdout = run.stdout;

    // Tier 1: same exact name in two different files.
    assert.match(stdout, /TIER 1/);
    const tier1Lines = stdout
      .split('\n')
      .filter((line) => line.includes('sharedThing()'));
    assert.ok(
      tier1Lines.some((line) => line.includes('src/a.ts') && line.includes('src/b.ts')),
      `tier-1 sharedThing pair missing from stdout:\n${stdout}`,
    );

    // Tier 2: normalised names addLogEntry / add_log_entry.
    assert.match(stdout, /TIER 2/);
    assert.ok(
      /addLogEntry \/ add_log_entry|add_log_entry \/ addLogEntry/.test(stdout),
      `normalised-name pair missing from stdout:\n${stdout}`,
    );

    // Identifiers inside strings/templates/comments are not functions.
    for (const fake of ['fakeFromString', 'fakeFromComment', 'fakeFromTemplate']) {
      assert.ok(!stdout.includes(fake), `${fake} leaked into the report`);
    }
    // Skipped files must not contribute functions either.
    assert.ok(!stdout.includes('ignored.d.ts'));
    assert.ok(!stdout.includes('ignored.test.ts'));

    // Ubiquitous filter is ON by default and reports its (zero) total.
    assert.match(stdout, /Ignored as ubiquitous: 0 pairs/);

    const markdown = fs.readFileSync(report, 'utf8');
    assert.match(markdown, /CANDIDATES, not verdicts/);
    assert.match(markdown, /sharedThing/);
    assert.match(markdown, /Evidence pruning/);
    assert.match(markdown, /ruled-out/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: ubiquitous-name filter CLI (default, --no-ignore, --ignore)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcand-filter-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      [
        'export class Alpha { constructor(value: number) { this.value = value; } }',
        'export function foo(x: number) { return x + 1; }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(srcDir, 'b.ts'),
      [
        'export class Beta { constructor(value: number) { this.value = value; } }',
        'export function foo(x: number) { return x + 2; }',
        '',
      ].join('\n'),
    );

    const run = (args) => {
      const report = path.join(dir, `report-${args.join('_') || 'default'}.md`);
      const res = spawnSync(
        process.execPath,
        [TOOL, '--src', srcDir, '--report', report, ...args],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(res.status, 0, `expected exit 0 for ${args.join(' ')}; stderr: ${res.stderr}`);
      return { stdout: res.stdout, markdown: fs.readFileSync(report, 'utf8') };
    };

    // 1. Default: constructor excluded from the inline listing, but counted and
    //    still written to the report under its own section.
    const def = run([]);
    assert.ok(!/constructor\(\)/.test(def.stdout), 'constructor must not be listed inline by default');
    assert.match(def.stdout, /Ignored as ubiquitous: 1 pairs \(constructor: 1\)/);
    assert.match(def.stdout, /foo\(\)/, 'the non-ubiquitous pair is still listed');
    assert.match(def.markdown, /## Ignored candidates/);
    assert.match(def.markdown, /constructor/);

    // 2. --no-ignore: the filter is off and the pair comes back inline.
    const all = run(['--no-ignore']);
    assert.match(all.stdout, /constructor\(\)/);
    assert.match(all.stdout, /Ignored as ubiquitous: 0 pairs \(filter disabled/);

    // 3. --ignore foo: the default list is REPLACED, not extended.
    const replaced = run(['--ignore', 'foo']);
    assert.match(replaced.stdout, /Ignored as ubiquitous: 1 pairs \(foo: 1\)/);
    assert.match(replaced.stdout, /constructor\(\)/, 'constructor is no longer ignored');
    assert.ok(!/\bfoo\(\)/.test(replaced.stdout), 'foo must now be filtered out');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Determinism (tools/README.md rule 7: "Two runs over the same tree produce
// byte-identical output, so reports diff cleanly.")
// ---------------------------------------------------------------------------

test('end-to-end: two runs over the same tree are byte-identical (no wall-clock stamp)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcand-det-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      'export function sharedThing(value: number) { return value + 1; }\n',
    );
    fs.writeFileSync(
      path.join(srcDir, 'b.ts'),
      'export function sharedThing(value: number) { return value + 2; }\n',
    );

    // Deliberately a different report path each run: the report must not embed
    // its own filename, and the only thing that may vary between runs is nothing.
    const runReport = (name, extraArgs = []) => {
      const report = path.join(dir, name);
      const res = spawnSync(
        process.execPath,
        [TOOL, '--src', srcDir, '--report', report, ...extraArgs],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(res.status, 0, `expected exit 0 for ${name}; stderr: ${res.stderr}`);
      return fs.readFileSync(report, 'utf8');
    };

    const first = runReport('one.md');
    const second = runReport('two.md');
    assert.equal(second, first, 'two runs over the same tree must be byte-identical');
    assert.ok(
      !/^- Generated:/m.test(first),
      'the report must carry no wall-clock stamp by default',
    );

    // Provenance is still available, but only when the caller supplies the value,
    // so a stamped report is reproducible too.
    const stamped = runReport('stamped.md', ['--generated', 'TEST-STAMP']);
    assert.match(stamped, /^- Generated: TEST-STAMP$/m);
    const stampedAgain = runReport('stamped2.md', ['--generated', 'TEST-STAMP']);
    assert.equal(stampedAgain, stamped, 'an explicitly supplied stamp is reproducible');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The HowTo — the strategy for what to do with a candidate
// ---------------------------------------------------------------------------

test('end-to-end: the two de-duplication strategies ship in stdout and in the report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcand-howto-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      'export function sharedThing(value: number) { return value + 1; }\n',
    );
    fs.writeFileSync(
      path.join(srcDir, 'b.ts'),
      'export function sharedThing(value: number) { return value + 2; }\n',
    );

    const report = path.join(dir, 'out.md');
    const res = spawnSync(
      process.execPath,
      [TOOL, '--src', srcDir, '--report', report],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, `expected exit 0; stderr: ${res.stderr}`);
    const markdown = fs.readFileSync(report, 'utf8');

    // There are exactly TWO ways to de-duplicate — pin the count so a future edit
    // has to be deliberate, not accidental.
    assert.equal(DEDUP_STRATEGIES.length, 2, 'there are exactly two ways to de-duplicate');

    // The HowTo must reach the human in BOTH outputs.
    assert.match(res.stdout, /HowTo/);
    assert.match(markdown, /## HowTo/);

    // Every strategy is rendered from the one source of truth (DEDUP_STRATEGIES),
    // which is what stops the stdout summary and the report from drifting apart.
    for (const strategy of DEDUP_STRATEGIES) {
      assert.ok(
        res.stdout.includes(strategy.title),
        `stdout is missing a strategy: ${strategy.title}`,
      );
      assert.ok(
        markdown.includes(strategy.title),
        `report is missing a strategy: ${strategy.title}`,
      );
    }

    // The honest third answer travels too: not de-duplicating is legitimate.
    assert.ok(
      markdown.includes(DEDUP_CAVEAT),
      'the report must state that leaving a candidate is a legitimate outcome',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Completeness — the tool must place itself among the ESTABLISHED methods
// ---------------------------------------------------------------------------

test('docs: names the established clone-detection methods and the clone types', () => {
  const tool = fs.readFileSync(path.join(HERE, 'find-duplicate-candidates.mjs'), 'utf8');
  const readme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
  const all = `${tool}\n${readme}`;

  // The families a reader could actually reach for instead of this tool.
  for (const method of [
    'jscpd',
    'PMD CPD',
    'SonarQube',
    'CCFinder',
    'SourcererCC',
    'NiCad',
    'Deckard',
    'sonarjs/no-identical-functions',
  ]) {
    assert.ok(all.includes(method), `the tool and its docs should name: ${method}`);
  }
  // The standard taxonomy, so "Type 4" is not an unexplained phrase.
  for (const phrase of ['Type 1', 'Type 2', 'Type 3', 'Type 4']) {
    assert.ok(readme.includes(phrase), `README should explain the clone taxonomy: ${phrase}`);
  }
  // And the honest positioning: it is an extension to those methods, not a detector.
  assert.ok(readme.includes('not a Type-4 detector') || readme.includes('not a Type-4 detector.'));
});

test('portability: no source-project specifics in the tool, its docs or its output', () => {
  // A tool that gets copied into other repos must never carry the script names,
  // gate paths or directories of the project it happened to be written in. Two
  // such leaks have already been found and fixed here; this is the regression guard.
  const leaks = ['duplication:check', 'scripts/gate.sh', 'projects/Expert'];
  const sources = {
    'find-duplicate-candidates.mjs': fs.readFileSync(
      path.join(HERE, 'find-duplicate-candidates.mjs'),
      'utf8',
    ),
    'README.md': fs.readFileSync(path.join(HERE, 'README.md'), 'utf8'),
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcand-port-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      'export function sharedThing(value: number) { return value + 1; }\n',
    );
    fs.writeFileSync(
      path.join(srcDir, 'b.ts'),
      'export function sharedThing(value: number) { return value + 2; }\n',
    );
    const report = path.join(dir, 'out.md');
    const res = spawnSync(
      process.execPath,
      [TOOL, '--src', srcDir, '--report', report],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, `expected exit 0; stderr: ${res.stderr}`);
    sources['(generated stdout)'] = res.stdout;
    sources['(generated report)'] = fs.readFileSync(report, 'utf8');

    for (const [name, body] of Object.entries(sources)) {
      for (const leak of leaks) {
        assert.ok(!body.includes(leak), `${name} leaks a source-project specific string: ${leak}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Source languages (extensions)
// ---------------------------------------------------------------------------

test('extensions: default set excludes markup, --ext replaces and normalises', () => {
  assert.deepEqual(DEFAULT_EXTENSIONS, ['.ts', '.js', '.mjs', '.cjs']);
  assert.deepEqual(resolveExtensions({}), ['.ts', '.js', '.mjs', '.cjs']);

  // Markup-bearing extensions are deliberate gaps, never silent additions: the
  // tokenizer cannot parse markup, so scanning them would report fabricated
  // functions instead of admitting it did not understand the file.
  for (const markup of ['.tsx', '.jsx', '.vue', '.svelte']) {
    assert.ok(!DEFAULT_EXTENSIONS.includes(markup), `${markup} must not be scanned`);
  }

  // --ext REPLACES the default (like --ignore); bare names, case and spaces OK.
  assert.deepEqual(resolveExtensions({ ext: 'ts,mjs' }), ['.ts', '.mjs']);
  assert.deepEqual(resolveExtensions({ ext: ' .JS , Mjs ' }), ['.js', '.mjs']);
  assert.deepEqual(normaliseExtensions(['ts', '.MJS', '']), ['.ts', '.mjs']);

  // Skip suffixes follow the extension list, so --ext stays coherent.
  assert.deepEqual(skipSuffixesFor(['.mjs']), ['.d.ts', '.test.mjs', '.spec.mjs']);
  assert.ok(skipSuffixesFor(DEFAULT_EXTENSIONS).includes('.spec.cjs'));
});

test('end-to-end: scans .js/.mjs/.cjs, skips their tests/specs and all markup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupcand-js-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'a.mjs'), 'export function sharedThing(v) { return v + 1; }\n');
    fs.writeFileSync(path.join(srcDir, 'b.js'), 'export function sharedThing(v) { return v + 2; }\n');
    fs.writeFileSync(
      path.join(srcDir, 'c.cjs'),
      'function addLogEntry(x) { return x; }\nmodule.exports = { addLogEntry };\n',
    );
    fs.writeFileSync(path.join(srcDir, 'd.js'), 'function add_log_entry(x) { return x.trim(); }\n');
    // Skipped: tests/specs in EVERY supported extension, not just .ts.
    fs.writeFileSync(path.join(srcDir, 'a.test.mjs'), 'export function sharedThing(v) { return v; }\n');
    fs.writeFileSync(path.join(srcDir, 'b.spec.js'), 'export function sharedThing(v) { return v; }\n');
    // NOT scanned: markup needs a real extractor.
    fs.writeFileSync(path.join(srcDir, 'view.jsx'), 'export function sharedThing() { return <div />; }\n');
    fs.writeFileSync(path.join(srcDir, 'view.tsx'), 'export function sharedThing() { return <div />; }\n');

    const report = path.join(dir, 'out.md');
    const res = spawnSync(
      process.execPath,
      [TOOL, '--src', srcDir, '--report', report],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, `expected exit 0; stderr: ${res.stderr}`);

    // Exactly the 4 supported sources: the .mjs/.js pair, the .cjs/.js pair, and
    // nothing else — the two test files and the two markup files are excluded.
    assert.match(res.stdout, /Scan: 4 files scanned/);
    assert.ok(res.stdout.includes('sharedThing()'), 'tier-1 pair across .mjs and .js is missing');
    assert.match(
      res.stdout,
      /addLogEntry \/ add_log_entry|add_log_entry \/ addLogEntry/,
      'tier-2 pair across .cjs and .js is missing',
    );
    for (const excluded of ['a.test.mjs', 'b.spec.js', 'view.jsx', 'view.tsx']) {
      assert.ok(!res.stdout.includes(excluded), `${excluded} must not be scanned`);
    }

    // The report records the languages actually scanned.
    assert.match(
      fs.readFileSync(report, 'utf8'),
      /Extensions scanned: `\.ts`, `\.js`, `\.mjs`, `\.cjs`/,
    );

    // --ext REPLACES the set: only .mjs remains, and its test is still skipped.
    const onlyMjs = spawnSync(
      process.execPath,
      [TOOL, '--src', srcDir, '--report', path.join(dir, 'mjs.md'), '--ext', '.mjs'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(onlyMjs.status, 0, `expected exit 0; stderr: ${onlyMjs.stderr}`);
    assert.match(onlyMjs.stdout, /Scan: 1 files scanned/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
