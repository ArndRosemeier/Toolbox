#!/usr/bin/env node
/**
 * repeated-code — code written more than once, WHATEVER IT IS CALLED.
 *
 * `duplicate-candidates` finds functions that share a name. It is blind to the
 * two kinds of copy that cost the most in a long-lived codebase:
 *
 *  1. **Body clones** — whole functions with (near-)identical bodies under
 *     DIFFERENT names: `clamp01` here, `saturate` there, `sat` in a third file.
 *     Found with MinHash + LSH over shingles of the body's shape (identifiers ->
 *     ID, numbers -> NUM), verified with an exact Jaccard.
 *  2. **Repeated idioms** — the same inline snippet, not wrapped in any function
 *     at all, pasted into many files: the hand-written water test, the hand-made
 *     "damage = min(1, damage + x)", the angle-wrap loop. Found by hashing every
 *     window of W tokens with PROPERTY AND METHOD NAMES KEPT (`.isWater`,
 *     `.bridgeDeck`, `Math.hypot`) and local names erased, counting how many
 *     FILES each window appears in, extending each hit to its maximal shared run
 *     and ranking by how specific its names are (IDF over files: `.x` is
 *     everywhere and says little, `.bridgeDeck` says a lot).
 *
 * Like every tool here it is a POINTER, not a judge: it lists candidates with
 * evidence, prints its own pruning counters, writes everything it filtered to
 * the report, and exits 0.
 *
 * Usage:
 *   node tools/repeated-code/find-repeated-code.mjs
 *   node tools/repeated-code/find-repeated-code.mjs --src src --report reports/repeated-code.md
 *   node tools/repeated-code/find-repeated-code.mjs --min-files 4 --window 20
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maskCode,
  tokenize,
  shape,
  extractFunctions,
  listSourceFiles,
  resolveExtensions,
} from '../duplicate-candidates/find-duplicate-candidates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_SRC = path.join(REPO_ROOT, 'src');
const DEFAULT_REPORT = path.join(REPO_ROOT, 'reports', 'repeated-code.md');

/** Idioms: tokens per window, and in how many different files a window must recur. */
export const DEFAULT_WINDOW = 16;
export const DEFAULT_MIN_FILES = 3;
/**
 * Idioms: minimum specificity (sum of the IDF, in bits, of the distinct kept names
 * in the snippet). Below it a snippet is generic glue (`a.x - b.x, a.z - b.z`):
 * counted, written to the report's filtered section, recoverable with `--min-info 0`.
 */
export const DEFAULT_MIN_INFO = 6;
/** Body clones: minimum body size (tokens), shingle length, verified Jaccard floor. */
export const DEFAULT_MIN_BODY = 40;
export const SHINGLE = 5;
export const DEFAULT_CLONE_FLOOR = 0.7;
/** MinHash signature = BANDS x ROWS hashes; LSH buckets bigger than this are skipped (and counted). */
export const BANDS = 16;
export const ROWS = 4;
export const MAX_BUCKET = 60;

const MAX_PRINT = 25;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Words kept verbatim in an idiom's shape: the language itself and its globals. */
export const KEPT_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'of', 'return', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'var', 'void', 'while', 'yield', 'await', 'async', 'static',
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'Math', 'Number', 'Object', 'Array', 'JSON', 'String', 'Boolean', 'Date',
  'Map', 'Set', 'WeakMap', 'Promise', 'Symbol', 'console', 'performance',
  'window', 'document', 'globalThis',
]);

/** Language words carry no information about WHAT a snippet does: never count them as names. */
const STRUCTURAL = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'of', 'return', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'var', 'void', 'while', 'yield', 'await', 'async', 'static',
  'true', 'false', 'null', 'undefined',
]);

/**
 * The idiom view of a token stream: punctuation as is, numbers and (masked)
 * strings -> NUM, a name after `.` kept as `.name`, language words and globals
 * kept, every other identifier -> ID. Returns the normalised strings and, per
 * token, the kept NAME it carries (or null) for the specificity score.
 *
 * @param {{v:string, kind:string}[]} tokens
 */
export function idiomShape(tokens) {
  const norm = new Array(tokens.length);
  const names = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    names[i] = null;
    if (t.kind === 'num') { norm[i] = 'NUM'; continue; }
    if (t.kind !== 'id') { norm[i] = t.v; continue; }
    const prev = i > 0 ? tokens[i - 1].v : '';
    if (prev === '.') { norm[i] = t.v; names[i] = `.${t.v}`; continue; }
    if (KEPT_WORDS.has(t.v)) {
      norm[i] = t.v;
      if (!STRUCTURAL.has(t.v)) names[i] = t.v;
      continue;
    }
    norm[i] = 'ID';
  }
  return { norm, names };
}

// ---------------------------------------------------------------------------
// Hashing (deterministic, 32-bit)
// ---------------------------------------------------------------------------

/** FNV-1a of a string, 32-bit unsigned. */
export function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Murmur3 finaliser: a cheap, well-mixed 32-bit permutation. */
function mix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// 1. Body clones (different names, near-identical bodies)
// ---------------------------------------------------------------------------

/** Set of hashed SHINGLE-grams over a body's shape. */
export function shingles(bodyTokens, k = SHINGLE) {
  const sh = shape(bodyTokens);
  const out = new Set();
  for (let i = 0; i + k <= sh.length; i += 1) out.add(fnv(sh.slice(i, i + k).join(' ')));
  return out;
}

/** MinHash signature (BANDS*ROWS values) of a shingle set. */
export function minhash(set) {
  const n = BANDS * ROWS;
  const sig = new Array(n).fill(0xffffffff);
  for (const x of set) {
    for (let i = 0; i < n; i += 1) {
      const h = mix32(x ^ Math.imul(i + 1, 0x9e3779b1));
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

function jaccardSets(a, b) {
  let inter = 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of s) if (l.has(v)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Clusters of functions whose bodies are near-identical, whatever their names.
 *
 * @param {{name:string, file:string, line:number, size:number, tokens:object[]}[]} functions
 * @param {{minBody?:number, floor?:number}} [opts]
 */
export function findBodyClones(functions, opts = {}) {
  const minBody = opts.minBody ?? DEFAULT_MIN_BODY;
  const floor = opts.floor ?? DEFAULT_CLONE_FLOOR;
  const stats = { functions: functions.length, tooSmall: 0, signed: 0, buckets: 0, oversizeBuckets: 0, candidatePairs: 0, nested: 0, ruledOutSize: 0, verified: 0, accepted: 0 };
  const items = [];
  for (const f of functions) {
    if (f.size < minBody) { stats.tooSmall += 1; continue; }
    const set = shingles(f.tokens);
    if (set.size === 0) { stats.tooSmall += 1; continue; }
    items.push({ f, set, sig: minhash(set) });
  }
  stats.signed = items.length;

  // LSH: identical band -> candidate pair.
  const buckets = new Map();
  for (let idx = 0; idx < items.length; idx += 1) {
    const sig = items[idx].sig;
    for (let b = 0; b < BANDS; b += 1) {
      const key = `${b}:${sig.slice(b * ROWS, b * ROWS + ROWS).join(',')}`;
      let list = buckets.get(key);
      if (!list) { list = []; buckets.set(key, list); }
      list.push(idx);
    }
  }
  const seen = new Set();
  const pairs = [];
  const keys = [...buckets.keys()].sort();
  for (const key of keys) {
    const list = buckets.get(key);
    if (list.length < 2) continue;
    stats.buckets += 1;
    if (list.length > MAX_BUCKET) { stats.oversizeBuckets += 1; continue; }
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i], b = list[j];
        const pk = a < b ? a * 1e7 + b : b * 1e7 + a;
        if (seen.has(pk)) continue;
        seen.add(pk);
        stats.candidatePairs += 1;
        const A = items[a], B = items[b];
        // A function nested in another (a callback, a local helper) is not a copy of it.
        if (A.f.file === B.f.file && A.f.line <= B.f.endLine && B.f.line <= A.f.endLine) { stats.nested += 1; continue; }
        // A Jaccard of `floor` is impossible when one set is much smaller than the other.
        const lo = Math.min(A.set.size, B.set.size), hi = Math.max(A.set.size, B.set.size);
        if (lo / hi < floor) { stats.ruledOutSize += 1; continue; }
        stats.verified += 1;
        const sim = jaccardSets(A.set, B.set);
        if (sim >= floor) { stats.accepted += 1; pairs.push({ a, b, sim }); }
      }
    }
  }

  // Union-find into clusters.
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const p of pairs) {
    const ra = find(p.a), rb = find(p.b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const groups = new Map();
  for (const p of pairs) {
    const r = find(p.a);
    let g = groups.get(r);
    if (!g) { g = { members: new Set(), minSim: 1 }; groups.set(r, g); }
    g.members.add(p.a); g.members.add(p.b);
    g.minSim = Math.min(g.minSim, p.sim);
  }
  const clusters = [];
  for (const g of groups.values()) {
    const fns = [...g.members].map((i) => items[i].f).sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line));
    const names = [...new Set(fns.map((f) => f.name))].sort();
    const files = new Set(fns.map((f) => f.file)).size;
    const size = Math.round(fns.reduce((s, f) => s + f.size, 0) / fns.length);
    clusters.push({ fns, names, files, size, minSim: Math.round(g.minSim * 100) / 100, sameName: names.length === 1 });
  }
  // Different names first (the other tool already lists same-name ones), then the most copies of the biggest body.
  clusters.sort((x, y) => (x.sameName !== y.sameName ? (x.sameName ? 1 : -1)
    : (y.files > 1) - (x.files > 1) || y.fns.length * y.size - x.fns.length * x.size || (x.fns[0].file < y.fns[0].file ? -1 : x.fns[0].file > y.fns[0].file ? 1 : x.fns[0].line - y.fns[0].line)));
  return { clusters, stats };
}

// ---------------------------------------------------------------------------
// 2. Repeated idioms (inline snippets recurring across files)
// ---------------------------------------------------------------------------

/**
 * @param {{file:string, source:string}[]} sources  file = display path
 * @param {{window?:number, minFiles?:number, minInfo?:number}} [opts]
 */
export function findIdioms(sources, opts = {}) {
  const W = opts.window ?? DEFAULT_WINDOW;
  const minFiles = opts.minFiles ?? DEFAULT_MIN_FILES;
  const minInfo = opts.minInfo ?? DEFAULT_MIN_INFO;
  const stats = { files: sources.length, tokens: 0, windows: 0, recurring: 0, lowInfo: 0, absorbed: 0, reported: 0 };

  // Per file: tokens, normalised stream (as ids), kept names.
  const vocab = new Map();
  const idOf = (s) => { let v = vocab.get(s); if (v === undefined) { v = vocab.size; vocab.set(s, v); } return v; };
  const docs = [];
  const df = new Map(); // kept name -> number of files containing it
  for (const { file, source } of sources) {
    const tokens = tokenize(maskCode(source));
    const { norm, names } = idiomShape(tokens);
    const ids = Int32Array.from(norm, idOf);
    for (const n of new Set(names.filter(Boolean))) df.set(n, (df.get(n) ?? 0) + 1);
    docs.push({ file, source, tokens, ids, names });
    stats.tokens += tokens.length;
  }
  const N = Math.max(1, docs.length);
  const idf = (n) => Math.log2(N / (df.get(n) ?? 1));

  // Hash every window; remember occurrences (first one per file).
  const occ = new Map();
  for (let d = 0; d < docs.length; d += 1) {
    const ids = docs[d].ids;
    for (let i = 0; i + W <= ids.length; i += 1) {
      let h1 = 0x811c9dc5, h2 = 0x2545f491;
      for (let k = 0; k < W; k += 1) {
        h1 = Math.imul(h1 ^ ids[i + k], 0x01000193);
        h2 = Math.imul(h2 ^ ids[i + k], 0x5bd1e995) ^ (h2 >>> 15);
      }
      const key = (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
      stats.windows += 1;
      let list = occ.get(key);
      if (!list) { list = []; occ.set(key, list); }
      const last = list[list.length - 1];
      if (!last || last.d !== d) list.push({ d, i });
    }
  }

  const sameWindow = (a, b, len) => {
    const x = docs[a.d].ids, y = docs[b.d].ids;
    for (let k = 0; k < len; k += 1) if (x[a.i + k] !== y[b.i + k]) return false;
    return true;
  };

  // Recurring windows -> verified groups, extended to the maximal shared run.
  const groups = [];
  for (const list of occ.values()) {
    if (list.length < minFiles) continue;
    // Verify against the first occurrence (hash collisions split off).
    const ref = list[0];
    const members = list.filter((o) => sameWindow(ref, o, W));
    if (members.length < minFiles) continue;
    stats.recurring += 1;
    let left = 0, right = 0;
    const agree = (off) => {
      const v0 = docs[members[0].d].ids[members[0].i + off];
      if (v0 === undefined) return false;
      for (const o of members) { const v = docs[o.d].ids[o.i + off]; if (v === undefined || v !== v0) return false; }
      return true;
    };
    while (members.every((o) => o.i - left - 1 >= 0) && agree(-left - 1)) left += 1;
    while (agree(W + right)) right += 1;
    const start = members.map((o) => ({ d: o.d, i: o.i - left }));
    const len = W + left + right;
    // Specificity: IDF of the distinct kept names in the run.
    const first = docs[start[0].d];
    const kept = new Set();
    for (let k = 0; k < len; k += 1) { const n = first.names[start[0].i + k]; if (n) kept.add(n); }
    const info = [...kept].reduce((s, n) => s + idf(n), 0);
    groups.push({ start, len, info: Math.round(info * 10) / 10, kept: [...kept].sort() });
  }

  // Rank: files x specificity, then longer, then position (deterministic).
  const pos = (g) => `${docs[g.start[0].d].file}\u0000${String(g.start[0].i).padStart(9, '0')}`;
  groups.sort((x, y) => y.start.length * y.info - x.start.length * x.info || y.len - x.len || (pos(x) < pos(y) ? -1 : pos(x) > pos(y) ? 1 : 0));

  // A window inside an already reported run is the same idiom seen again: absorb it.
  const covered = docs.map(() => []);
  // Overlap, not containment: a shifted or shorter variant of a reported run is still that run.
  const overlaps = (o, len) => covered[o.d].some((c) => o.i < c.i + c.len && c.i < o.i + len);
  const idioms = [], filtered = [];
  for (const g of groups) {
    const dup = g.start.filter((o) => overlaps(o, g.len)).length;
    if (dup * 2 >= g.start.length) { stats.absorbed += 1; continue; }
    for (const o of g.start) covered[o.d].push({ i: o.i, len: g.len });
    const entry = describe(g, docs);
    if (g.info < minInfo) { stats.lowInfo += 1; filtered.push(entry); continue; }
    stats.reported += 1;
    idioms.push(entry);
  }
  return { idioms, filtered, stats };
}

function describe(g, docs) {
  const at = g.start.map((o) => {
    const doc = docs[o.d];
    return { file: doc.file, line: doc.tokens[o.i].line, endLine: doc.tokens[o.i + g.len - 1].line };
  }).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const o = g.start[0], doc = docs[o.d];
  const lines = doc.source.split('\n');
  const l0 = doc.tokens[o.i].line, l1 = doc.tokens[o.i + g.len - 1].line;
  const excerpt = lines.slice(l0 - 1, Math.min(l1, l0 + 7)).map((l) => l.replace(/\s+$/, ''));
  if (l1 > l0 + 7) excerpt.push('…');
  return { files: at.length, tokens: g.len, info: g.info, names: g.kept, at, excerpt };
}

// ---------------------------------------------------------------------------
// Scan + render
// ---------------------------------------------------------------------------

export function scan(rootDir, opts = {}) {
  const { files, skipped, display, extensions } = listSourceFiles(rootDir, opts);
  const sources = [];
  const functions = [];
  for (const file of files) {
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch (err) { skipped.push({ file: display(file), reason: `read: ${err.code || err.message}` }); continue; }
    try {
      for (const fn of extractFunctions(source)) functions.push({ name: fn.name, file: display(file), line: fn.line, kind: fn.kind, size: fn.tokens.length, endLine: fn.tokens.length ? fn.tokens[fn.tokens.length - 1].line : fn.line, tokens: fn.tokens });
      sources.push({ file: display(file), source });
    } catch (err) {
      skipped.push({ file: display(file), reason: `parse: ${err.message}` });
    }
  }
  functions.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  const clones = findBodyClones(functions, opts);
  const idioms = findIdioms(sources, opts);
  return { filesScanned: files.length, extensions, functionCount: functions.length, skipped, clones, idioms };
}

const HEADER = [
  'Repeated-code CANDIDATES (copies under any name, and inline copies — NOT verdicts)',
  'These are CANDIDATES that require HUMAN REVIEW. Two snippets with the same shape',
  'can do different jobs; a recurring idiom can be fine (or a missing helper).',
];

function loc(a) { return a.endLine && a.endLine !== a.line ? `${a.file}:${a.line}-${a.endLine}` : `${a.file}:${a.line}`; }

function statLines(r) {
  const c = r.clones.stats, i = r.idioms.stats;
  return [
    `Scan: ${r.filesScanned} files, ${r.functionCount} functions, ${i.tokens} tokens, ${r.skipped.length} skipped`,
    `Body clones: ${c.signed} bodies signed (${c.tooSmall} under the size floor), ${c.buckets} LSH buckets (${c.oversizeBuckets} oversize, skipped), ${c.candidatePairs} candidate pairs: ${c.nested} nested in each other, ${c.ruledOutSize} ruled out by size, ${c.verified} verified, ${c.accepted} accepted -> ${r.clones.clusters.length} clusters (${r.clones.clusters.filter((x) => !x.sameName).length} with different names)`,
    `Idioms: ${i.windows} windows hashed, ${i.recurring} recur in enough files, ${i.absorbed} absorbed into a longer run, ${i.lowInfo} too generic (filtered, listed in the report), ${i.reported} reported`,
  ];
}

export function renderStdout(r, reportPath, opts = {}) {
  const max = opts.maxPrint ?? MAX_PRINT;
  const out = [...HEADER, '', ...statLines(r), `Report: ${reportPath}`, ''];
  const diff = r.clones.clusters.filter((x) => !x.sameName);
  out.push(`== BODY CLONES under different names (${diff.length} clusters) ==`);
  for (const c of diff.slice(0, max)) out.push(`  ${c.names.join(' / ')}  x${c.fns.length} in ${c.files} files, ~${c.size} tokens, sim>=${c.minSim}  ${c.fns.slice(0, 4).map((f) => `${f.file}:${f.line}`).join('  ')}${c.fns.length > 4 ? '  …' : ''}`);
  out.push('', `== REPEATED IDIOMS (${r.idioms.idioms.length}) ==`);
  for (const d of r.idioms.idioms.slice(0, max)) out.push(`  ${d.files} files, ${d.tokens} tokens, info ${d.info}  [${d.names.slice(0, 6).join(' ')}]  ${d.at.slice(0, 3).map(loc).join('  ')}${d.at.length > 3 ? '  …' : ''}`);
  out.push('', 'Full lists, excerpts and the filtered items: see the report.', '');
  return out.join('\n');
}

export function renderMarkdown(r, opts = {}) {
  const out = ['# Repeated-code candidates', '', ...HEADER.map((l) => `> ${l}`), ''];
  if (opts.generated) out.push(`- Generated: ${opts.generated}`, '');
  out.push('## Scan stats', '', ...statLines(r).map((l) => `- ${l}`), '');
  if (r.skipped.length) { out.push('### Skipped files', ''); for (const s of r.skipped) out.push(`- \`${s.file}\` — ${s.reason}`); out.push(''); }
  const section = (title, list) => {
    out.push(`## ${title} — ${list.length}`, '');
    for (const c of list) {
      out.push(`### \`${c.names.join('` / `')}\` — ${c.fns.length} copies in ${c.files} files, ~${c.size} tokens, sim ≥ ${c.minSim}`, '');
      for (const f of c.fns) out.push(`- \`${f.file}:${f.line}\` \`${f.name}\``);
      out.push('');
    }
  };
  section('Body clones under different names', r.clones.clusters.filter((x) => !x.sameName));
  const idiomSection = (title, list) => {
    out.push(`## ${title} — ${list.length}`, '');
    for (const d of list) {
      out.push(`### ${d.files} files, ${d.tokens} tokens, info ${d.info} — ${d.names.map((n) => `\`${n}\``).join(' ') || '(no names)'}`, '');
      out.push('```', ...d.excerpt, '```', '');
      for (const a of d.at) out.push(`- \`${loc(a)}\``);
      out.push('');
    }
  };
  idiomSection('Repeated idioms', r.idioms.idioms);
  section('Body clones with the same name (also listed by duplicate-candidates)', r.clones.clusters.filter((x) => x.sameName));
  idiomSection('Filtered: generic idioms (below --min-info; recover with --min-info 0)', r.idioms.filtered);
  out.push('## What to do with a candidate', '',
    '- **A body clone** under several names: keep the best one in a shared module, point every caller at it, delete the rest. Check edge cases first (bounds, NaN, a cap that lowers a value): copies drift.',
    '- **A repeated idiom** is usually a missing helper: name it once (`isOpenWater(x, z)`), replace the copies, and add a guard (a test that fails when the raw idiom reappears) so the next copy is caught when it is born.',
    '- **Or leave it**: a short, obvious idiom can be cheaper inline than behind a helper. Leaving it is a decision, not an omission.',
    '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {};
  const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${name} needs a number`); return n; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const [k, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (k === '--help' || k === '-h') o.help = true;
    else if (k === '--src') o.src = val();
    else if (k === '--report') o.report = val();
    else if (k === '--ext') o.ext = val();
    else if (k === '--generated') o.generated = val();
    else if (k === '--max') o.max = num(val(), k);
    else if (k === '--window') o.window = Math.max(4, num(val(), k));
    else if (k === '--min-files') o.minFiles = Math.max(2, num(val(), k));
    else if (k === '--min-info') o.minInfo = num(val(), k);
    else if (k === '--min-body') o.minBody = num(val(), k);
    else if (k === '--clone-floor') o.floor = num(val(), k);
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`error: ${err.message}`); process.exitCode = 1; return; }
  if (args.help) {
    console.log([
      'Usage: node tools/repeated-code/find-repeated-code.mjs [options]',
      '',
      '  --src DIR          source root                     (default: <repo>/src)',
      '  --report FILE      markdown report                 (default: reports/repeated-code.md)',
      '  --ext a,b,c        extensions, as duplicate-candidates',
      `  --window N         idiom window, tokens            (default: ${DEFAULT_WINDOW})`,
      `  --min-files N      idiom must recur in N files     (default: ${DEFAULT_MIN_FILES})`,
      `  --min-info BITS    idiom specificity floor         (default: ${DEFAULT_MIN_INFO}; 0 lists everything)`,
      `  --min-body N       smallest body for clones        (default: ${DEFAULT_MIN_BODY} tokens)`,
      `  --clone-floor X    body Jaccard to count as clone  (default: ${DEFAULT_CLONE_FLOOR})`,
      `  --max N            entries per section on stdout   (default: ${MAX_PRINT})`,
      '  --generated VAL    stamp the report (omitted by default: runs are byte-identical)',
    ].join('\n'));
    return;
  }
  const srcRoot = path.resolve(args.src || DEFAULT_SRC);
  const reportPath = path.resolve(args.report || DEFAULT_REPORT);
  if (!fs.existsSync(srcRoot)) { console.error(`error: source root not found: ${srcRoot}`); process.exitCode = 1; return; }
  let r;
  try {
    r = scan(srcRoot, { displayBase: path.dirname(srcRoot), extensions: resolveExtensions(args), window: args.window, minFiles: args.minFiles, minInfo: args.minInfo, minBody: args.minBody, floor: args.floor });
  } catch (err) { console.error(`error: scan failed: ${err && err.stack ? err.stack : err}`); process.exitCode = 1; return; }
  process.stdout.write(renderStdout(r, reportPath, { maxPrint: args.max }));
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, renderMarkdown(r, { generated: args.generated }), 'utf8');
  } catch (err) { console.error(`error: could not write report ${reportPath}: ${err.message}`); process.exitCode = 1; return; }
  process.exitCode = 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
