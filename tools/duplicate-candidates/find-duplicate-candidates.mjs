#!/usr/bin/env node
/**
 * find-duplicate-candidates.mjs
 *
 * A dependency-free, name-based DISCOVERY helper for Type-4 clone candidates
 * (functions that do the same job but are written differently).
 *
 *   IT IS A POINTER, NOT A JUDGE.
 *   It groups function-like declarations that share a name / near-name across
 *   different files and prints them as CANDIDATES for a human to review.
 *   It never claims two functions ARE duplicates.
 *
 * Why this exists next to the established detectors: token-based tools (jscpd, PMD
 * CPD, SonarQube) and AST-based tools (NiCad, Deckard,
 * sonarjs/no-identical-functions) match STRUCTURE, so they are blind to a function
 * that was rewritten under the same name — there is no identical token run and no
 * isomorphic subtree. This tool matches NAMES instead and closes that *discovery*
 * gap cheaply. It accepts over-reporting; it must not silently miss things.
 *
 * Usage:
 *   node tools/duplicate-candidates/find-duplicate-candidates.mjs
 *   node tools/duplicate-candidates/find-duplicate-candidates.mjs --src src --report reports/duplicate-candidates.md
 *   node tools/duplicate-candidates/find-duplicate-candidates.mjs --src src --generated "$(date -u +%FT%TZ)"
 *   node tools/duplicate-candidates/find-duplicate-candidates.mjs --src app --ext .js,.mjs
 *
 * Node >= 24, built-ins only. Exit 0 even when candidates are found
 * (finding candidates is success); non-zero only on a real error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

const DEFAULT_SRC = path.join(REPO_ROOT, 'src');
const DEFAULT_REPORT = path.join(REPO_ROOT, 'reports', 'duplicate-candidates.md');

// Body-evidence pruning thresholds (see compareBodies).
/** Below this body-shape Jaccard a pair is declared ruled out (not a duplicate). */
export const DEFAULT_SIM_FLOOR = 0.3;
/** Above this guaranteed-lower-bound we stop the walk early and mark `confirmed`. */
export const DEFAULT_CONFIRM_FLOOR = 0.6;
/** If shorter body is < 50% of the longer, the pair cannot be a duplicate. */
export const DEFAULT_SIZE_RATIO = 0.5;

/**
 * UBIQUITOUS-NAME FILTER — auditable, editable, and never a cover-up.
 *
 * These names repeat structurally in any TypeScript codebase, so a pair that
 * shares one carries almost no duplicate signal; without this list the tier-1
 * listing is ~73% `constructor()` and the useful candidates sink below the fold.
 *
 * Filtering is a DISPLAY convenience only. Every ignored pair is:
 *   - counted and printed as a total (stdout AND report),
 *   - still written to the report under its own "Ignored candidates" section,
 *   - recoverable in full with `--no-ignore` (which reproduces the unfiltered
 *     tier counts exactly), and replaceable with `--ignore a,b,c`.
 *
 * Classes of name, and why each is here:
 *   - lifecycle/boilerplate: constructor, render, destroy, componentDidMount,
 *     componentWillUnmount, setupEventListeners, attachEventListeners,
 *     addEventListeners — every component/class has its own by construction.
 *   - ubiquitous API surface: open, close, cleanup, clear, initialize, init,
 *     getInstance — same singleton/UI shape repeated by convention.
 *   - language & runtime callbacks: toString, valueOf, main, handler, handleEvent
 *     — prescribed by the language, the entry point, or the event system.
 *
 * A pair is ignored only when ALL of its names (normalised) are listed, so a
 * near-match like `open` / `openDocument` is kept: only the unrelated half is
 * ubiquitous.
 */
export const DEFAULT_IGNORED_NAMES = [
  // lifecycle / boilerplate
  'constructor',
  'render',
  'destroy',
  'componentDidMount',
  'componentWillUnmount',
  'setupEventListeners',
  'attachEventListeners',
  'addEventListeners',
  // ubiquitous API surface
  'open',
  'close',
  'cleanup',
  'clear',
  'initialize',
  'init',
  'getInstance',
  // language / runtime callbacks
  'toString',
  'valueOf',
  'main',
  'handler',
  'handleEvent',
];


// ---------------------------------------------------------------------------
// Masking: comments + strings + template literals + regex literals
// ---------------------------------------------------------------------------

/**
 * Replaces every string / template / regex literal with the single character
 * `0` and blanks out comments, preserving newlines so token line numbers stay
 * 1-based and correct. This is what stops text inside strings and comments
 * from creating fake functions.
 *
 * @param {string} code
 * @returns {string}
 */
export function maskCode(code) {
  const n = code.length;
  let out = '';
  let i = 0;
  const blank = (ch) => (ch === '\n' ? '\n' : ch === '\r' ? '\r' : ' ');

  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];

    // line comment
    if (c === '/' && c2 === '/') {
      while (i < n && code[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    // block comment
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        out += blank(code[i]);
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    // single / double quoted string
    if (c === '"' || c === "'") {
      out += '0';
      i += 1;
      while (i < n) {
        if (code[i] === '\\') {
          out += blank(code[i]);
          i += 1;
          if (i < n) {
            out += blank(code[i]);
            i += 1;
          }
          continue;
        }
        if (code[i] === c) {
          i += 1;
          break;
        }
        out += blank(code[i]);
        i += 1;
      }
      continue;
    }

    // template literal (including any ${ ... } inside it)
    if (c === '`') {
      out += '0';
      i += 1;
      while (i < n) {
        if (code[i] === '\\') {
          out += blank(code[i]);
          i += 1;
          if (i < n) {
            out += blank(code[i]);
            i += 1;
          }
          continue;
        }
        if (code[i] === '`') {
          i += 1;
          break;
        }
        out += blank(code[i]);
        i += 1;
      }
      continue;
    }

    // regex literal (heuristic: a `/` in expression position)
    if (c === '/' && isRegexStart(out)) {
      out += '0';
      i += 1;
      let inClass = false;
      while (i < n) {
        const rc = code[i];
        if (rc === '\\') {
          i += 1;
          if (i < n) i += 1;
          continue;
        }
        if (rc === '\n') break;
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

function isRegexStart(out) {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j])) j -= 1;
  if (j < 0) return true;
  const ch = out[j];
  if (/[A-Za-z0-9_$]/.test(ch)) {
    // `return /re/` etc. are regexes, `foo / bar` is division.
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) k -= 1;
    return REGEX_PREFIX_KEYWORDS.has(out.slice(k + 1, j + 1));
  }
  if (ch === ')' || ch === ']') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * @param {string} masked output of maskCode()
 * @returns {{v: string, line: number, kind: 'id'|'num'|'punct'}[]}
 */
export function tokenize(masked) {
  const tokens = [];
  let line = 1;
  let i = 0;
  const n = masked.length;
  while (i < n) {
    const c = masked[i];
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(masked[j])) j += 1;
      tokens.push({ v: masked.slice(i, j), line, kind: 'id' });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(masked[j])) j += 1;
      tokens.push({ v: masked.slice(i, j), line, kind: 'num' });
      i = j;
      continue;
    }
    tokens.push({ v: c, line, kind: 'punct' });
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Pure name helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Lowercase, drop underscores and dollar signs. */
export function normaliseName(name) {
  return String(name).toLowerCase().replace(/[_$]/g, '');
}

/** Split camelCase / snake_case / SCREAMING_CASE / digit boundaries into words. */
export function splitNameTokens(name) {
  const spaced = String(name)
    .replace(/[_$]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export const COMMON_AFFIXES = [
  'get', 'set', 'handle', 'on', 'try', 'do', 'make', 'create', 'build',
  'update', 'process', 'render', 'load', 'save', 'init', 'is', 'has', 'can',
  'should',
];

/** Strip leading/trailing common affix words. Never returns an empty list. */
export function stripAffixes(words) {
  let out = words.slice();
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    while (out.length > 1 && COMMON_AFFIXES.includes(out[0])) {
      out = out.slice(1);
      changed = true;
    }
    while (out.length > 1 && COMMON_AFFIXES.includes(out[out.length - 1])) {
      out = out.slice(0, -1);
      changed = true;
    }
  }
  return out.length ? out : words.slice();
}

/**
 * Near-name test: affix-stripped token SETS equal, or affix-stripped names
 * within a small (<= 2) edit distance.
 */
export function nearMatch(aName, bName) {
  const a = stripAffixes(splitNameTokens(aName));
  const b = stripAffixes(splitNameTokens(bName));
  const setA = [...new Set(a)].sort().join('|');
  const setB = [...new Set(b)].sort().join('|');
  if (setA === setB) return true;
  const sa = a.join('');
  const sb = b.join('');
  if (Math.abs(sa.length - sb.length) > 2) return false;
  return levenshtein(sa, sb, 2) <= 2;
}

/** Bounded Levenshtein distance. */
export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(val);
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Token sequence with every identifier replaced by `ID` and numbers by `NUM`. */
export function shape(tokens) {
  return tokens.map((t) => {
    if (t.kind === 'id') return 'ID';
    if (t.kind === 'num') return 'NUM';
    return t.v;
  });
}

/** Jaccard similarity of two iterables (0 when both are empty). */
export function jaccard(a, b) {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const v of setA) if (setB.has(v)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/**
 * Lazily build (and memoise) the body shape token-set for a function record.
 * The body tokens are only touched here, which is what lets the size prefilter
 * rule a pair out without ever tokenising its bodies.
 */
export function getShapeSet(fn, stats) {
  if (!fn._shapeSet) {
    const tokens = fn.tokens || fn._tokens || [];
    fn._shapeSet = new Set(shape(tokens));
    if (stats) stats.shapeComputations += 1;
  }
  return fn._shapeSet;
}

/**
 * PRUNE-FIRST body evidence comparison.
 *
 * It exits as early as it honestly can and records WHY:
 *
 *  1. `ruled-out (size)`     — length prefilter; bodies are NOT tokenised at all
 *                              (shorter body < sizeRatio of the longer).
 *  2. `ruled-out (disjoint)` — incremental set walk bails the moment the maximum
 *                              achievable Jaccard (inter + remaining) / union
 *                              cannot reach the reporting floor.
 *  3. `confirmed`            — incremental walk stops once the guaranteed
 *                              lower bound inter/(union-inter) already clears the
 *                              confirm floor; `sim` is then a lower bound.
 *  4. `compared`             — neither early exit fired; `sim` is exact.
 *
 * @param {{size:number, tokens:object[], _shapeSet:?Set<string>}} a
 * @param {{size:number, tokens:object[], _shapeSet:?Set<string>}} b
 * @param {{stats?:object, floor?:number, confirmFloor?:number, sizeRatio?:number}} [opts]
 */
export function compareBodies(a, b, opts = {}) {
  const stats = opts.stats || null;
  const floor = opts.floor ?? DEFAULT_SIM_FLOOR;
  const confirmFloor = opts.confirmFloor ?? DEFAULT_CONFIRM_FLOOR;
  const sizeRatio = opts.sizeRatio ?? DEFAULT_SIZE_RATIO;
  const bump = (key) => {
    if (stats) stats[key] = (stats[key] || 0) + 1;
  };
  const noteExamined = (n) => {
    if (stats) stats.examinedTotal += n;
  };

  const short = Math.min(a.size, b.size);
  const long = Math.max(a.size, b.size);

  // 1. Length prefilter. Deliberately does not touch a.tokens / b.tokens.
  const ratio = long === 0 ? 0 : short / long;
  if (long === 0 || ratio < sizeRatio) {
    bump('prunedSize');
    return {
      status: 'ruled-out-size',
      reason: 'size',
      sim: null,
      examined: 0,
      sizeRatio: round2(ratio),
      floor,
      confirmFloor,
    };
  }

  // Only now does the evidence stage pay for tokenising the bodies.
  const setA = getShapeSet(a, stats);
  const setB = getShapeSet(b, stats);
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  const union = setA.size + setB.size;
  let inter = 0;
  let examined = 0;

  for (const token of small) {
    examined += 1;
    if (large.has(token)) inter += 1;

    // Maximum achievable Jaccard if every unexamined token still matched.
    const remaining = small.size - examined;
    const maxInter = inter + remaining;
    const maxSim = maxInter === 0 ? 0 : maxInter / (union - maxInter);
    if (maxSim < floor) {
      bump('prunedDisjoint');
      noteExamined(examined);
      return {
        status: 'ruled-out-disjoint',
        reason: 'disjoint',
        sim: null,
        examined,
        sizeRatio: round2(ratio),
        floor,
        confirmFloor,
      };
    }

    // Minimum achievable Jaccard (intersection can only grow): if that already
    // clears the confirm floor, the pair is confirmed without finishing. Only
    // genuinely early: once the smaller set is exhausted the walk IS complete,
    // so the fall-through below reports an exact `compared` score instead.
    const minSim = inter === 0 ? 0 : inter / (union - inter);
    if (remaining > 0 && minSim >= confirmFloor) {
      bump('confirmed');
      noteExamined(examined);
      return {
        status: 'confirmed',
        reason: 'confirmed',
        sim: round2(minSim),
        simIsLowerBound: true,
        examined,
        sizeRatio: round2(ratio),
        floor,
        confirmFloor,
      };
    }
  }

  const sim = inter === 0 ? 0 : inter / (union - inter);
  bump('compared');
  noteExamined(examined);
  return {
    status: 'compared',
    reason: 'compared',
    sim: round2(sim),
    examined,
    sizeRatio: round2(ratio),
    floor,
    confirmFloor,
  };
}

/** Fresh counters for one groupCandidates run. */
export function newPruneStats() {
  return {
    pairs: 0,
    compared: 0,
    confirmed: 0,
    prunedSize: 0,
    prunedDisjoint: 0,
    shapeComputations: 0,
    examinedTotal: 0,
  };
}

// ---------------------------------------------------------------------------
// Function-like extraction
// ---------------------------------------------------------------------------

const CLOSERS = { '(': ')', '[': ']', '{': '}' };

const NOT_NAMES = new Set([
  'function', 'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else',
  'new', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete', 'void', 'await',
  'yield', 'throw', 'class', 'extends', 'super', 'this', 'import', 'export',
  'default', 'const', 'let', 'var', 'try', 'finally', 'null', 'true', 'false',
  'undefined', 'async', 'get', 'set', 'static', 'public', 'private',
  'protected', 'readonly', 'declare', 'abstract', 'override', 'enum',
  'interface', 'type', 'namespace', 'module', 'from', 'as', 'satisfies',
  'keyof', 'infer', 'is', 'asserts', 'require', 'with', 'debugger',
]);

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'static', 'readonly', 'abstract',
  'override', 'declare', 'async', 'get', 'set', 'export', 'default',
]);

const MEMBER_PREV = new Set([
  '{', '}', ';', ',', '*', ...MODIFIERS,
]);

const EXPR_CONTINUATIONS = new Set([
  '=', '.', '(', '[', ',', '?', ':', '+', '-', '*', '/', '%', '&&', '||', '=>',
  '<', '>', '|', '&', '!', '~', 'return', 'typeof', 'new', 'await', 'in', 'of',
  'instanceof',
]);

/**
 * Lowercase primitive type words. A bare `() => void` (or `: string`) is a TYPE
 * SIGNATURE, not a function: none of these is a valid standalone value expression
 * in JS/TS (the globals are capitalised — `String`, `Number`, …), so skipping such
 * a body cannot hide a real function. This matters for `.tsx`, where prop types like
 * `{ onDone: () => void }` are everywhere. A body of two or more tokens is NOT
 * skipped, so a real `() => void doSomething()` is still collected.
 */
const BARE_TYPE_WORDS = new Set([
  'void', 'string', 'number', 'boolean', 'any', 'unknown', 'never', 'object',
  'symbol', 'bigint',
]);

const BLOCK_STARTERS = new Set([
  'const', 'let', 'var', 'return', 'if', 'for', 'while', 'function', 'class',
  'export', 'import', 'switch', 'try', 'throw', 'do', 'else', 'interface',
  'type', 'enum',
]);

/** Index of the token closing the bracket opened at `start`, or -1. */
export function findMatch(tokens, start) {
  const open = tokens[start] && tokens[start].v;
  const close = CLOSERS[open];
  if (!close) return -1;
  let depth = 0;
  for (let j = start; j < tokens.length; j += 1) {
    const v = tokens[j].v;
    if (v === open) depth += 1;
    else if (v === close) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Index of the `>` matching the `<` opened at `start`, or -1. */
function findAngleMatch(tokens, start) {
  let depth = 0;
  for (let j = start; j < tokens.length; j += 1) {
    const v = tokens[j].v;
    if (v === '<') depth += 1;
    else if (v === '>') {
      depth -= 1;
      if (depth === 0) return j;
      if (depth < 0) return -1;
    } else if (v === ';' || v === '{' || v === '}') {
      return -1;
    }
  }
  return -1;
}

/**
 * Starting right after a parameter list, find the body `{`, skipping an
 * object-literal return-type annotation. Returns its index or -1.
 */
function findBodyBlock(tokens, from) {
  let depth = 0;
  for (let j = from; j < tokens.length; j += 1) {
    const v = tokens[j].v;
    if (v === '(' || v === '[' || v === '<') {
      depth += 1;
      continue;
    }
    if (v === ')' || v === ']') {
      depth -= 1;
      if (depth < 0) return -1;
      continue;
    }
    if (v === '>') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (v === '{') {
      if (depth > 0) {
        const m = findMatch(tokens, j);
        if (m < 0) return -1;
        j = m;
        continue;
      }
      const prev = j > 0 ? tokens[j - 1].v : '';
      if (prev === ':') {
        // `): { a: number } {` — a return-type object literal.
        const m = findMatch(tokens, j);
        if (m < 0) return -1;
        j = m;
        continue;
      }
      return j;
    }
    if (v === ';' || v === '=') return -1;
  }
  return -1;
}

/** Find `=>` at nesting depth 0 at or after `from`. */
function findArrow(tokens, from) {
  let depth = 0;
  for (let j = from; j < tokens.length; j += 1) {
    const v = tokens[j].v;
    if (v === '(' || v === '[' || v === '{' || v === '<') depth += 1;
    else if (v === ')' || v === ']' || v === '}' || v === '>') {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (v === ';' && depth === 0) return -1;
    else if (
      v === '=' &&
      depth === 0 &&
      tokens[j + 1] &&
      tokens[j + 1].v === '>' &&
      !['=', '!', '<', '>'].includes(tokens[j - 1] && tokens[j - 1].v)
    ) {
      return j;
    }
  }
  return -1;
}

/** End (exclusive) of a brace-less arrow body. */
function findExpressionBodyEnd(tokens, from) {
  let depth = 0;
  let j = from;
  for (; j < tokens.length; j += 1) {
    const v = tokens[j].v;
    if (v === '(' || v === '[' || v === '{') depth += 1;
    else if (v === ')' || v === ']' || v === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (v === ';' || v === ',')) break;
    else if (
      depth === 0 &&
      j > from &&
      tokens[j].line > tokens[j - 1].line &&
      BLOCK_STARTERS.has(v)
    ) {
      break;
    }
    if (j - from > 400) break;
  }
  return j;
}

function isMemberContext(tokens, i) {
  if (i === 0) return true;
  const p = tokens[i - 1];
  if (p.kind === 'id' && MODIFIERS.has(p.v)) return true;
  if (MEMBER_PREV.has(p.v)) return true;
  if (p.v === '.') return false;
  if (p.line < tokens[i].line && !EXPR_CONTINUATIONS.has(p.v)) return true;
  return false;
}

function bodySlice(tokens, braceStart) {
  if (braceStart < 0) return null;
  const end = findMatch(tokens, braceStart);
  const stop = end > 0 ? end : tokens.length;
  return tokens.slice(braceStart + 1, stop);
}

/**
 * Read a function/arrow VALUE beginning at `from` (just after an `=` or `:`).
 * Handles `function [name]() {}`, `async function () {}`, `() => …`, `x => …`,
 * `async () => …` and generic `<T>(…) => …`. Returns null when the value is not a
 * function, so callers can apply it to any assignment or property without guessing.
 *
 * Shared by the `const/let/var` branch and the object-property / class-field
 * branch so the two cannot drift apart.
 *
 * @returns {{kind: string, body: object[]}|null}
 */
function readFunctionValue(tokens, from) {
  let r = from;
  let prefix = '';
  if (tokens[r] && tokens[r].v === 'async') {
    prefix = 'async-';
    r += 1;
  }

  if (tokens[r] && tokens[r].v === 'function') {
    let k = r + 1;
    if (tokens[k] && tokens[k].v === '*') k += 1;
    // optional function-expression name: `= function named() {}`
    if (tokens[k] && tokens[k].kind === 'id' && tokens[k + 1] && tokens[k + 1].v === '(') {
      k += 1;
    }
    if (tokens[k] && tokens[k].v === '(') {
      const close = findMatch(tokens, k);
      if (close > 0) {
        const body = bodySlice(tokens, findBodyBlock(tokens, close + 1));
        if (body) return { kind: 'function-expression', body };
      }
    }
    return null;
  }

  // `x => …` — the single parameter IS the arrow.
  if (
    tokens[r] && tokens[r].kind === 'id' && !NOT_NAMES.has(tokens[r].v)
    && tokens[r + 1] && tokens[r + 1].v === '='
    && tokens[r + 2] && tokens[r + 2].v === '>'
  ) {
    const bodyStart = r + 3;
    const body = tokens[bodyStart] && tokens[bodyStart].v === '{'
      ? bodySlice(tokens, bodyStart)
      : tokens.slice(bodyStart, findExpressionBodyEnd(tokens, bodyStart));
    return body ? { kind: `${prefix}arrow`, body } : null;
  }

  let paramsClose = -1;
  if (tokens[r] && tokens[r].v === '(') {
    paramsClose = findMatch(tokens, r);
  } else if (tokens[r] && tokens[r].v === '<') {
    const m = findAngleMatch(tokens, r);
    if (m > 0 && tokens[m + 1] && tokens[m + 1].v === '(') {
      paramsClose = findMatch(tokens, m + 1);
    }
  }
  if (paramsClose > 0) {
    const arrow = findArrow(tokens, paramsClose + 1);
    if (arrow > 0) {
      const bodyStart = arrow + 2;
      const body = tokens[bodyStart] && tokens[bodyStart].v === '{'
        ? bodySlice(tokens, bodyStart)
        : tokens.slice(bodyStart, findExpressionBodyEnd(tokens, bodyStart));
      if (body) return { kind: `${prefix}arrow`, body };
    }
  }
  return null;
}

/** True when a body is a lone primitive type word — a signature, not a function. */
function isBareTypeSignature(body) {
  return body.length === 1 && BARE_TYPE_WORDS.has(body[0].v);
}

/**
 * Extract every function-like declaration from a source string.
 *
 * @param {string} source
 * @returns {{name: string, line: number, kind: string, tokens: object[]}[]}
 */
export function extractFunctions(source) {
  const tokens = tokenize(maskCode(source));
  const found = [];
  const push = (name, line, kind, body) => {
    if (!body) return;
    found.push({ name, line, kind, tokens: body });
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];

    // --- function declarations / named function expressions -----------------
    if (t.v === 'function') {
      let j = i + 1;
      if (tokens[j] && tokens[j].v === '*') j += 1;
      const nameTok = tokens[j];
      if (nameTok && nameTok.kind === 'id' && !NOT_NAMES.has(nameTok.v)) {
        let k = j + 1;
        if (tokens[k] && tokens[k].v === '<') {
          const m = findAngleMatch(tokens, k);
          if (m > 0) k = m + 1;
        }
        if (tokens[k] && tokens[k].v === '(') {
          const close = findMatch(tokens, k);
          if (close > 0) {
            const body = bodySlice(tokens, findBodyBlock(tokens, close + 1));
            push(nameTok.v, nameTok.line, 'function', body);
          }
        }
      }
      continue;
    }

    // --- const / let / var assigned function or arrow ------------------------
    if (t.v === 'const' || t.v === 'let' || t.v === 'var') {
      const nameTok = tokens[i + 1];
      if (nameTok && nameTok.kind === 'id' && !NOT_NAMES.has(nameTok.v)) {
        const eq = findTopLevelAssign(tokens, i + 2);
        if (eq > 0) {
          const fn = readFunctionValue(tokens, eq + 1);
          if (fn) push(nameTok.v, nameTok.line, fn.kind, fn.body);
        }
      }
      continue;
    }

    // --- object-property and class-field functions ---------------------------
    //   `{ workerCount: () => … }`   object literal / property
    //   `{ onDone: function () {…} }`
    //   `workerCount = () => …`      class field
    // There is no declaration keyword, so the branch above cannot see these — a
    // real miss: object-property arrows were invisible to the tool entirely.
    if (t.kind === 'id' && !NOT_NAMES.has(t.v) && isMemberContext(tokens, i)) {
      const sep = tokens[i + 1];
      if (sep && (sep.v === ':' || sep.v === '=')) {
        const fn = readFunctionValue(tokens, i + 2);
        // A lone `() => void` / `: string` is a type signature, not a function.
        if (fn && !isBareTypeSignature(fn.body)) {
          push(t.v, t.line, `property-${fn.kind}`, fn.body);
        }
      }
    }

    // --- class methods, object-literal methods, getters/setters --------------
    if (t.kind === 'id' && !NOT_NAMES.has(t.v) && isMemberContext(tokens, i)) {
      let k = i + 1;
      if (tokens[k] && tokens[k].v === '<') {
        const m = findAngleMatch(tokens, k);
        if (m > 0) k = m + 1;
      }
      if (tokens[k] && tokens[k].v === '(') {
        const close = findMatch(tokens, k);
        if (close > 0) {
          const body = bodySlice(tokens, findBodyBlock(tokens, close + 1));
          if (body) push(t.v, t.line, 'method', body);
        }
      }
    }
  }

  return found;
}

/** Find the assignment `=` at depth 0, skipping an optional type annotation. */
function findTopLevelAssign(tokens, from) {
  let depth = 0;
  for (let j = from; j < tokens.length; j += 1) {
    const v = tokens[j].v;
    if (v === '(' || v === '[' || v === '{' || v === '<') depth += 1;
    else if (v === ')' || v === ']' || v === '}' || v === '>') {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (v === ';' && depth === 0) {
      return -1;
    } else if (v === '=' && depth === 0) {
      const next = tokens[j + 1] && tokens[j + 1].v;
      const prev = tokens[j - 1] && tokens[j - 1].v;
      if (next === '=' || next === '>') return -1;
      if (prev === '=' || prev === '!' || prev === '<' || prev === '>') return -1;
      return j;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Directory scan
// ---------------------------------------------------------------------------

const SKIP_DIR_PREFIXES = ['node_modules', 'dist'];

/**
 * Source extensions the extractor understands. `--ext a,b,c` replaces this list.
 *
 * `.tsx` / `.jsx` ARE included: measured on a realistic component file, the
 * tokenizer extracts the declarations correctly and JSX prose does not fabricate
 * functions (the `>` that closes a tag is in EXPR_CONTINUATIONS, so a word after a
 * tag is never treated as a member name). Excluding them silently missed every
 * component in a React codebase — the failure mode this tool exists to avoid.
 *
 * `.vue` / `.svelte` stay OUT: they are single-file components where markup
 * dominates and a `<script>` block may be absent, so the tokenizer would ingest the
 * template as code. Those need a real extractor — see tools/README.md.
 */
export const DEFAULT_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
];

/** Normalise `--ext` values: trim, lowercase, and guarantee a leading dot. */
export function normaliseExtensions(list) {
  return list
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.startsWith('.') ? s : `.${s}`));
}

/**
 * Resolve the extension list from parsed CLI args.
 *   (no flag)          -> DEFAULT_EXTENSIONS
 *   --ext ts,mjs,.js   -> exactly those (replaces the default, like --ignore)
 */
export function resolveExtensions(args = {}) {
  if (args.ext === undefined) return DEFAULT_EXTENSIONS.slice();
  return normaliseExtensions(String(args.ext).split(','));
}

/**
 * File suffixes to skip in any supported language: declaration files, and
 * tests/specs. Derived from the extension list so `--ext` stays coherent — add
 * `.foo` and `*.test.foo` / `*.spec.foo` are skipped with it.
 */
export function skipSuffixesFor(extensions) {
  const out = ['.d.ts'];
  for (const ext of extensions) out.push(`.test${ext}`, `.spec${ext}`);
  return out;
}

/**
 * Walk `rootDir` for source files in the supported languages and extract
 * functions. Never follows symlinks, never throws on an individual file (it is
 * counted as skipped instead).
 *
 * @param {string} rootDir absolute path
 * @param {{displayBase?: string, extensions?: string[]}} [opts]
 */
export function scanTree(rootDir, opts = {}) {
  const displayBase = opts.displayBase || path.dirname(rootDir);
  const extensions = opts.extensions && opts.extensions.length
    ? opts.extensions
    : DEFAULT_EXTENSIONS;
  const skipSuffixes = skipSuffixesFor(extensions);
  const files = [];
  const skipped = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ file: display(dir), reason: `readdir: ${err.code || err.message}` });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow symlinks
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_PREFIXES.some((p) => entry.name === p || entry.name.startsWith(p))) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensions.some((e) => entry.name.endsWith(e))) continue;
      if (skipSuffixes.some((s) => entry.name.endsWith(s))) continue;
      files.push(full);
    }
  };

  const display = (abs) => {
    const rel = path.relative(displayBase, abs);
    return rel.startsWith('..') ? abs : rel;
  };

  walk(rootDir);

  const functions = [];
  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (err) {
      skipped.push({ file: display(file), reason: `read: ${err.code || err.message}` });
      continue;
    }
    try {
      for (const fn of extractFunctions(source)) {
        functions.push({
          name: fn.name,
          file: display(file),
          line: fn.line,
          kind: fn.kind,
          size: fn.tokens.length,
          tokens: fn.tokens,
          _shapeSet: null,
        });
      }
    } catch (err) {
      skipped.push({ file: display(file), reason: `parse: ${err.message}` });
    }
  }

  functions.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return { rootDir, filesScanned: files.length, extensions, functions, skipped };
}

// ---------------------------------------------------------------------------
// Grouping into three tiers
// ---------------------------------------------------------------------------

function orderKey(fn) {
  return `${fn.file}\u0000${String(fn.line).padStart(8, '0')}\u0000${fn.name}`;
}

function makePair(f, g) {
  const [a, b] = orderKey(f) <= orderKey(g) ? [f, g] : [g, f];
  return {
    a,
    b,
    key: `${a.file}:${a.line}|${b.file}:${b.line}`,
    status: 'pending',
    reason: null,
    sim: null,
  };
}

function crossFilePairs(list) {
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (list[i].file === list[j].file) continue;
      pairs.push(makePair(list[i], list[j]));
    }
  }
  return pairs;
}

/** Run the pruning comparison for every pair in a tier and attach the verdict. */
function attachEvidence(pairs, stats, opts) {
  for (const p of pairs) {
    const evidence = compareBodies(p.a, p.b, { ...opts, stats });
    p.status = evidence.status;
    p.reason = evidence.reason;
    p.sim = evidence.sim;
    p.simIsLowerBound = Boolean(evidence.simIsLowerBound);
    p.examined = evidence.examined;
    p.sizeRatio = evidence.sizeRatio;
  }
  if (stats) stats.pairs += pairs.length;
  return pairs;
}

const STATUS_RANK = {
  compared: 0,
  confirmed: 0,
  'ruled-out-size': 1,
  'ruled-out-disjoint': 2,
};

function sortPairs(pairs) {
  return pairs.sort((x, y) => {
    const rx = STATUS_RANK[x.status] ?? 3;
    const ry = STATUS_RANK[y.status] ?? 3;
    if (rx !== ry) return rx - ry;
    const sx = x.sim ?? 0;
    const sy = y.sim ?? 0;
    if (sy !== sx) return sy - sx;
    if (x.a.name !== y.a.name) return x.a.name < y.a.name ? -1 : 1;
    if (x.a.file !== y.a.file) return x.a.file < y.a.file ? -1 : 1;
    if (x.a.line !== y.a.line) return x.a.line - y.a.line;
    if (x.b.file !== y.b.file) return x.b.file < y.b.file ? -1 : 1;
    return x.b.line - y.b.line;
  });
}

function groupBy(functions, keyFn) {
  const map = new Map();
  for (const fn of functions) {
    const key = keyFn(fn);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(fn);
  }
  return map;
}

/** Display key for an ignored pair (also the key of the count breakdown). */
export function ignoredPairName(p) {
  return p.a.name === p.b.name ? p.a.name : `${p.a.name} / ${p.b.name}`;
}

/** Normalised lookup set for an ignore list. */
export function toIgnoreSet(ignoreList) {
  return new Set((ignoreList || []).map((n) => normaliseName(n)));
}

/**
 * A pair is "ubiquitous" only when EVERY one of its names (normalised) is in the
 * ignore set — so `open` / `openDocument` is kept: only one half is boilerplate.
 */
export function isUbiquitousPair(p, normalisedIgnore) {
  if (!normalisedIgnore || normalisedIgnore.size === 0) return false;
  const names = p.a.name === p.b.name ? [p.a.name] : [p.a.name, p.b.name];
  return names.every((n) => normalisedIgnore.has(normaliseName(n)));
}

function sortIgnored(pairs) {
  return pairs.sort((x, y) => {
    const nx = ignoredPairName(x);
    const ny = ignoredPairName(y);
    if (nx !== ny) return nx < ny ? -1 : 1;
    const sx = x.sim ?? 0;
    const sy = y.sim ?? 0;
    if (sy !== sx) return sy - sx;
    if (x.a.file !== y.a.file) return x.a.file < y.a.file ? -1 : 1;
    if (x.a.line !== y.a.line) return x.a.line - y.a.line;
    if (x.b.file !== y.b.file) return x.b.file < y.b.file ? -1 : 1;
    return x.b.line - y.b.line;
  });
}

/**
 * Build the three candidate tiers. Every pair appears in exactly ONE tier: the
 * strongest one that applies, so tiers stay readable and nothing is repeated.
 *
 * Each surviving pair gets a body-shape Jaccard HINT; pairs the evidence stage
 * ruled out carry the prune reason instead of a misleading score.
 *
 * UBIQUITOUS-NAME FILTER: pairs whose every name is in the ignore list are moved
 * out of the tier lists into `ignored`, counted in `ignoredTotal` /
 * `ignoredByName`, and still reported in full. Nothing is silently dropped;
 * `ignoreList: []` disables the filter entirely (the `--no-ignore` flag).
 *
 * @param {object[]} functions output of scanTree().functions
 * @param {{floor?:number, confirmFloor?:number, sizeRatio?:number, stats?:object, ignoreList?:string[]|null}} [opts]
 */
export function groupCandidates(functions, opts = {}) {
  const stats = opts.stats || newPruneStats();
  const ignoreList = opts.ignoreList === undefined ? DEFAULT_IGNORED_NAMES : opts.ignoreList;
  const ignoreSet = toIgnoreSet(ignoreList);
  const seen = new Set();
  const ignored = [];
  const ignoredByName = new Map();

  const take = (pairs) => {
    const out = [];
    for (const p of pairs) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      out.push(p);
    }
    return out;
  };

  const processTier = (pairs, tierName) => {
    const taken = take(pairs);
    attachEvidence(taken, stats, opts);
    const kept = [];
    for (const p of taken) {
      p.tier = tierName;
      if (isUbiquitousPair(p, ignoreSet)) {
        ignored.push(p);
        const key = ignoredPairName(p);
        ignoredByName.set(key, (ignoredByName.get(key) || 0) + 1);
      } else {
        kept.push(p);
      }
    }
    return sortPairs(kept);
  };

  // Tier 1 — exact name match across different files.
  const exact = [];
  for (const list of groupBy(functions, (f) => f.name).values()) {
    if (list.length < 2) continue;
    exact.push(...crossFilePairs(list));
  }
  const tier1 = processTier(exact, 1);

  // Tier 2 — normalised name match (lowercase, `_`/`$` removed).
  const normalised = [];
  for (const list of groupBy(functions, (f) => normaliseName(f.name)).values()) {
    if (list.length < 2) continue;
    normalised.push(...crossFilePairs(list));
  }
  const tier2 = processTier(normalised, 2);

  // Tier 3 — near name match (affix stripping + token split + edit distance).
  const byName = new Map();
  for (const fn of functions) {
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }
  const names = [...byName.keys()].sort();
  const prep = new Map();
  for (const name of names) {
    const words = stripAffixes(splitNameTokens(name));
    prep.set(name, {
      words,
      setKey: [...new Set(words)].sort().join('|'),
      joined: words.join(''),
    });
  }
  const nearPairs = [];
  for (let i = 0; i < names.length; i += 1) {
    const pa = prep.get(names[i]);
    for (let j = i + 1; j < names.length; j += 1) {
      const pb = prep.get(names[j]);
      let match = pa.setKey === pb.setKey;
      if (!match && Math.abs(pa.joined.length - pb.joined.length) <= 2) {
        match = levenshtein(pa.joined, pb.joined, 2) <= 2;
      }
      if (!match) continue;
      nearPairs.push(...crossFilePairs([...byName.get(names[i]), ...byName.get(names[j])]));
    }
  }
  const tier3 = processTier(nearPairs, 3);

  return {
    tier1,
    tier2,
    tier3,
    ignored: sortIgnored(ignored),
    ignoredByName,
    ignoredTotal: ignored.length,
    ignoreList: ignoreList || [],
    stats,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const MAX_PRINT_PER_TIER = 60;

function pairName(p) {
  return p.a.name === p.b.name ? p.a.name : `${p.a.name} / ${p.b.name}`;
}

function simText(sim) {
  return sim.toFixed(2);
}

/** The evidence column: a Jaccard hint, or the honest reason it was pruned. */
function evidenceText(p) {
  if (p.status === 'compared') return `sim=${simText(p.sim)}`;
  if (p.status === 'confirmed') return `sim>=${simText(p.sim)} (confirmed early)`;
  return `ruled-out (${p.reason})`;
}

/** Requirement 4: the counters that prove the early exits actually fire. */
export function pruneSummaryLines(stats, functionCount) {
  const total = stats.pairs || 0;
  const pct = (n) => (total === 0 ? '0' : ((n / total) * 100).toFixed(1));
  return [
    `Evidence pruning: ${total} candidate comparisons`,
    `  fully compared: ${stats.compared} (${pct(stats.compared)}%)`,
    `  confirmed early (high end): ${stats.confirmed} (${pct(stats.confirmed)}%)`,
    `  ruled-out (size, bodies NOT tokenised): ${stats.prunedSize} (${pct(stats.prunedSize)}%)`,
    `  ruled-out (disjoint, partial walk): ${stats.prunedDisjoint} (${pct(stats.prunedDisjoint)}%)`,
    `  shape sets built: ${stats.shapeComputations} function(s)${functionCount ? ` of ${functionCount}` : ''}; shape tokens examined: ${stats.examinedTotal}`,
  ];
}

/** Names-by-count for the ubiquitous breakdown, count desc then name asc. */
function ignoredBreakdown(tiers, limit = 12) {
  const entries = [...tiers.ignoredByName.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return { entries, shown: entries.slice(0, limit), more: Math.max(0, entries.length - limit) };
}

/** Requirement 2: ignored pairs are always counted, never silently dropped. */
export function ignoredSummaryLine(tiers, limit = 12) {
  if (!tiers.ignoreList || tiers.ignoreList.length === 0) {
    return 'Ignored as ubiquitous: 0 pairs (filter disabled — --no-ignore)';
  }
  if (tiers.ignoredTotal === 0) {
    return `Ignored as ubiquitous: 0 pairs (none matched the ${tiers.ignoreList.length}-name default list)`;
  }
  const { shown, more } = ignoredBreakdown(tiers, limit);
  const parts = shown.map(([name, count]) => `${name}: ${count}`);
  const tail = more > 0 ? `, … +${more} more name(s)` : '';
  return `Ignored as ubiquitous: ${tiers.ignoredTotal} pairs (${parts.join(', ')}${tail})`;
}

// ---------------------------------------------------------------------------
// HowTo — what to do with a candidate
//
// The tool POINTS and never JUDGES (tools/README.md rule 4), but a candidate list
// is only useful if the reader knows what to do with one. The strategy is stated
// ONCE here and rendered into BOTH outputs, so the stdout summary and the report
// cannot drift apart.
// ---------------------------------------------------------------------------

export const DEDUP_STRATEGIES = [
  {
    title: 'Literally the same thing? Keep one, delete the other',
    detail:
      'Same inputs, same outputs, same edge cases. Keep the better of the two '
      + '(clearer, better named, fewer surprises), delete the other, and point every '
      + 'caller at the survivor. Check the near-invisible differences BEFORE you '
      + 'delete — off-by-one bounds, `<` vs `<=`, null/undefined handling, a swallowed '
      + 'error, a different default. If you find one, the pair is not literally the '
      + 'same; it is the next case.',
  },
  {
    title: 'Big and nearly identical, differing by one twist? Add one parameter',
    detail:
      'Introduce a single parameter that expresses the difference, and let one '
      + 'function do both. This pays off BECAUSE the body is big: a large duplicated '
      + 'body is expensive to keep in sync and will drift. A short almost-duplicate is '
      + 'usually cheaper left alone (or shared as a tiny helper) than turned into '
      + 'something with an extra flag. Give the parameter a default that reproduces '
      + "today's behaviour, then migrate call sites one at a time so every "
      + 'intermediate state keeps working. The parameter must express a variation of '
      + 'ONE job — if the "twist" is really a different job, or it takes several flags '
      + 'to cover the variants, keep two functions instead.',
  },
];

export const DEDUP_CAVEAT =
  'Leaving a candidate alone is a legitimate, recorded outcome: if the similarity is '
  + 'cosmetic, or they are genuinely different jobs that happen to share a name, leave '
  + 'them — or rename one so the difference is obvious (often the right call for '
  + 'same-named `render`/`init`). What is never acceptable is merging or deleting a '
  + 'candidate merely to make the list shorter.';

/** Compact form for the stdout quick-look: the two ways, then a pointer. */
function howToStdoutLines() {
  const lines = ['HowTo — what to do with a candidate (the tool points; you decide):'];
  DEDUP_STRATEGIES.forEach((s, i) => lines.push(`  ${i + 1}. ${s.title}`));
  lines.push('  Otherwise leave it (or rename one). Full HowTo is in the report.');
  return lines;
}

export function renderStdout(result, tiers, reportPath, opts = {}) {
  const displayBase = opts.displayBase || path.dirname(result.rootDir);
  const relReport = path.relative(displayBase, reportPath);
  const shownReport = relReport.startsWith('..') ? reportPath : relReport;
  const lines = [];
  lines.push('Duplicate-function CANDIDATES (name-based discovery — NOT verdicts)');
  lines.push('These are CANDIDATES that require HUMAN REVIEW. A shared name or shape does');
  lines.push('NOT mean two functions are duplicates (two unrelated render() methods are fine).');
  lines.push('This tool over-reports on purpose: it must not silently miss anything.');
  lines.push('Complements structural detectors (token: jscpd/CPD/SonarQube; AST: NiCad,');
  lines.push('sonarjs/no-identical-functions), which miss a rewrite that kept its name.');
  lines.push('');
  lines.push(`Scan: ${result.filesScanned} files scanned (${(result.extensions || DEFAULT_EXTENSIONS).join(', ')}), ${result.functions.length} function-like declarations found, ${result.skipped.length} skipped`);
  const filterState = tiers.ignoreList.length === 0
    ? 'ubiquitous-name filter OFF (--no-ignore)'
    : `ubiquitous-name filter ON (${tiers.ignoreList.length} names; --no-ignore disables)`;
  lines.push(`Tiers: ${tiers.tier1.length} exact, ${tiers.tier2.length} normalised, ${tiers.tier3.length} near (each pair appears once, in its strongest tier; ${filterState})`);
  lines.push(ignoredSummaryLine(tiers));
  lines.push(...pruneSummaryLines(tiers.stats, result.functions.length));
  lines.push(`Report: ${shownReport}`);
  lines.push('Ignored pairs are counted above and listed IN FULL in the report under "Ignored candidates" —');
  lines.push('nothing is silently dropped; re-run with --no-ignore to see them inline, or with --ignore a,b,c to retune.');
  lines.push('`sim` = body-shape Jaccard HINT (2 decimals); it is only meaningful because the names already match.');
  lines.push('`sim>=X` means the walk was stopped early on a guaranteed lower bound; `ruled-out` means the');
  lines.push('prune rule fired and the pair is shown for completeness, without a misleading score.');
  lines.push('');

  const sections = [
    ['TIER 1 — EXACT name match across different files', tiers.tier1],
    ['TIER 2 — NORMALISED name match (case, _ and $ ignored)', tiers.tier2],
    ['TIER 3 — NEAR name match (affix-stripped tokens / small edit distance)', tiers.tier3],
  ];
  const maxPrint = opts.maxPrint ?? MAX_PRINT_PER_TIER;
  for (const [title, pairs] of sections) {
    lines.push(`== ${title} (${pairs.length} pair${pairs.length === 1 ? '' : 's'}) ==`);
    if (pairs.length === 0) {
      lines.push('  (none)');
    } else {
      for (const p of pairs.slice(0, maxPrint)) {
        lines.push(
          `  ${pairName(p)}()  ${evidenceText(p)}  ${p.a.file}:${p.a.line}  <->  ${p.b.file}:${p.b.line}`,
        );
      }
      if (pairs.length > maxPrint) {
        lines.push(`  ... ${pairs.length - maxPrint} more pair(s) — full list in ${shownReport} (or re-run with --max ${pairs.length})`);
      }
    }
    lines.push('');
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} path(s)/file(s) that could not be read or parsed (see report).`);
    lines.push('');
  }
  lines.push(...howToStdoutLines());
  return lines.join('\n') + '\n';
}

export function renderMarkdown(result, tiers, opts = {}) {
  // Provenance is OPT-IN (`opts.generated`, i.e. the `--generated` flag) so that
  // two runs over the same tree are byte-identical by default (tools/README.md
  // rule 7). A wall-clock default stamped every report with the current time,
  // which made consecutive reports differ on one line and defeated the whole
  // point: "reports diff cleanly".
  const { generated } = opts;
  const displayBase = opts.displayBase || path.dirname(result.rootDir);
  const rel = (p) => {
    const r = path.relative(displayBase, p);
    return r.startsWith('..') ? p : r;
  };
  const out = [];
  out.push('# Duplicate-function CANDIDATES (name-based)');
  out.push('');
  out.push('> **These are CANDIDATES, not verdicts.** They require human review.');
  out.push('> Two functions sharing a name (or a near-name) does **not** mean they are');
  out.push('> duplicates — same-named unrelated methods are legitimate. This tool');
  out.push('> deliberately over-reports: it must not silently miss anything, so a');
  out.push('> quiet report is not proof that no Type-4 clones exist.');
  out.push('>');
  out.push('> **Where it sits.** Established detectors match *structure*: token-based');
  out.push('> (`jscpd`, PMD CPD, SonarQube — the practical Type-1/2 tools), AST-based');
  out.push('> (NiCad, Deckard, `sonarjs/no-identical-functions`), and graph- or ML-based');
  out.push('> methods for semantic clones. This tool matches **names** instead, which is the');
  out.push('> angle they miss: a function rewritten under its old name leaves no identical');
  out.push('> token run and no isomorphic subtree, so the structural families report');
  out.push('> nothing. It is a cheap heuristic for that case — not a Type-4 detector.');
  out.push('');
  out.push('## Scan stats');
  out.push('');
  out.push(`- Source root: \`${rel(result.rootDir)}\``);
  out.push(`- Extensions scanned: ${(result.extensions || DEFAULT_EXTENSIONS).map((e) => `\`${e}\``).join(', ')}`);
  out.push(`- Files scanned: **${result.filesScanned}**`);
  out.push(`- Function-like declarations found: **${result.functions.length}**`);
  out.push(`- Paths/files skipped (unreadable or unparseable): **${result.skipped.length}**`);
  out.push(`- Tier 1 (exact name): **${tiers.tier1.length}** pairs`);
  out.push(`- Tier 2 (normalised name): **${tiers.tier2.length}** pairs`);
  out.push(`- Tier 3 (near name): **${tiers.tier3.length}** pairs`);
  out.push(`- Ignored as ubiquitous (counted, NOT shown inline by default): **${tiers.ignoredTotal}** pairs`);
  if (tiers.ignoreList.length === 0) {
    out.push('- Ubiquitous-name filter: **OFF** (`--no-ignore`)');
  } else {
    const { shown, more } = ignoredBreakdown(tiers, 20);
    out.push(`- Ubiquitous-name filter: **ON**, ${tiers.ignoreList.length} names (\`--no-ignore\` disables, \`--ignore a,b,c\` replaces)`);
    out.push(`- Ignored breakdown: ${shown.map(([n, c]) => `\`${n}\`: ${c}`).join(', ')}${more > 0 ? `, … +${more} more name(s)` : ''}`);
  }
  if (generated) out.push(`- Generated: ${generated}`);
  out.push('');
  out.push('### Evidence pruning (early exits actually taken)');
  out.push('');
  out.push('```');
  out.push(...pruneSummaryLines(tiers.stats, result.functions.length));
  out.push('```');
  out.push('');
  out.push('- **ruled-out (size)** — shorter body is under the size ratio, so it cannot');
  out.push('  be a duplicate; the bodies were **not tokenised at all**.');
  out.push('- **ruled-out (disjoint)** — the incremental set walk bailed as soon as the');
  out.push('  maximum achievable Jaccard could not reach the reporting floor.');
  out.push('- **confirmed** — the guaranteed lower bound already cleared the confirm');
  out.push('  floor, so the walk stopped; `sim` is a **lower bound**, not exact.');
  out.push('- **compared** — neither early exit fired; `sim` is exact.');
  out.push('');
  out.push('Each pair appears in exactly one tier — the strongest one that applies — so');
  out.push('tiers never repeat a candidate. Pairs whose **every** name is in the');
  out.push('ubiquitous-name ignore list are pulled out of those tiers and listed in the');
  out.push('"Ignored candidates" section below instead; they are still counted and never');
  out.push('dropped. Within a tier, ordering is stable: `sim` descending, then name, then');
  out.push('file/line, so two runs diff cleanly.');
  out.push('');
  out.push('`sim` is a **hint only**: Jaccard similarity of the two bodies\' shape');
  out.push('token-sets (identifiers replaced by `ID`, numbers by `NUM`). It is only');
  out.push('meaningful when the names already match.');
  out.push('');

  const sections = [
    ['Tier 1 — exact name match (different files)', tiers.tier1],
    ['Tier 2 — normalised name match (case, `_`, `$` ignored)', tiers.tier2],
    ['Tier 3 — near name match (affix-stripped tokens or small edit distance)', tiers.tier3],
  ];
  for (const [title, pairs] of sections) {
    out.push(`## ${title} — ${pairs.length} pair${pairs.length === 1 ? '' : 's'}`);
    out.push('');
    if (pairs.length === 0) {
      out.push('(none)');
      out.push('');
      continue;
    }
    out.push('| name | evidence | file A | file B | body tokens A | body tokens B |');
    out.push('| --- | --- | --- | --- | ---: | ---: |');
    for (const p of pairs) {
      const name = p.a.name === p.b.name ? `\`${p.a.name}()\`` : `\`${p.a.name}\` / \`${p.b.name}\``;
      out.push(
        `| ${name} | ${evidenceText(p)} | \`${p.a.file}:${p.a.line}\` | \`${p.b.file}:${p.b.line}\` | ${p.a.size} | ${p.b.size} |`,
      );
    }
    out.push('');
  }

  out.push('## HowTo — what to do with a candidate');
  out.push('');
  out.push('A candidate is a **question**, not a task. Open both functions (the');
  out.push('`file:line` above) and compare **intent**: if one changes, must the other');
  out.push('change too? If not, they are coincidentally-named twins — leave them, or');
  out.push('rename one. If yes, there are **two ways** to de-duplicate:');
  out.push('');
  DEDUP_STRATEGIES.forEach((s, i) => {
    out.push(`${i + 1}. **${s.title}.**`);
    out.push(`   ${s.detail}`);
  });
  out.push('');
  out.push(DEDUP_CAVEAT);
  out.push('');
  out.push('After either change, run the project gate and confirm behaviour did not');
  out.push('change — deletion and parameterisation are exactly where behaviour quietly');
  out.push('changes.');
  out.push('');

  if (tiers.ignoreList.length > 0) {
    out.push(`## Ignored candidates — ubiquitous names — ${tiers.ignoredTotal} pairs`);
    out.push('');
    out.push('> These are **candidates too**. They are excluded from the default stdout');
    out.push('> listing only, because the shared name is structurally expected to repeat and');
    out.push('> carries almost no duplicate signal. They are all recorded here, so nothing');
    out.push('> is lost: re-run with `--no-ignore` to inline them, or `--ignore a,b,c` to');
    out.push('> replace the list. The list itself is `DEFAULT_IGNORED_NAMES` in the tool.');
    out.push('');
    if (tiers.ignored.length === 0) {
      out.push('(no pair matched the ignore list)');
      out.push('');
    } else {
      const { shown, more } = ignoredBreakdown(tiers, 20);
      out.push(`Breakdown by name: ${shown.map(([n, c]) => `\`${n}\`: ${c}`).join(', ')}${more > 0 ? `, … +${more} more name(s)` : ''}`);
      out.push('');
      out.push('| name | tier | evidence | file A | file B | body tokens A | body tokens B |');
      out.push('| --- | ---: | --- | --- | --- | ---: | ---: |');
      for (const p of tiers.ignored) {
        out.push(
          `| \`${ignoredPairName(p)}\` | ${p.tier} | ${evidenceText(p)} | \`${p.a.file}:${p.a.line}\` | \`${p.b.file}:${p.b.line}\` | ${p.a.size} | ${p.b.size} |`,
        );
      }
      out.push('');
    }
  }

  if (result.skipped.length > 0) {
    out.push('## Skipped paths/files');
    out.push('');
    for (const s of result.skipped) out.push(`- \`${s.file}\` — ${s.reason}`);
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('Generated by `tools/duplicate-candidates/find-duplicate-candidates.mjs` (`npm run dup:candidates`).');
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--src') {
      opts.src = argv[++i];
    } else if (arg.startsWith('--src=')) {
      opts.src = arg.slice('--src='.length);
    } else if (arg === '--report') {
      opts.report = argv[++i];
    } else if (arg.startsWith('--report=')) {
      opts.report = arg.slice('--report='.length);
    } else if (arg === '--max') {
      opts.max = argv[++i];
    } else if (arg.startsWith('--max=')) {
      opts.max = arg.slice('--max='.length);
    } else if (arg === '--ignore') {
      opts.ignore = argv[++i];
    } else if (arg.startsWith('--ignore=')) {
      opts.ignore = arg.slice('--ignore='.length);
    } else if (arg === '--no-ignore') {
      opts.noIgnore = true;
    } else if (arg === '--generated') {
      opts.generated = argv[++i];
    } else if (arg.startsWith('--generated=')) {
      opts.generated = arg.slice('--generated='.length);
    } else if (arg === '--ext') {
      opts.ext = argv[++i];
    } else if (arg.startsWith('--ext=')) {
      opts.ext = arg.slice('--ext='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * Resolve the ubiquitous-name ignore list from parsed CLI args.
 *   (no flag)        -> DEFAULT_IGNORED_NAMES
 *   --ignore a,b,c   -> exactly that list (replaces the default)
 *   --no-ignore      -> [] (filter disabled)
 */
export function resolveIgnoreList(args = {}) {
  if (args.noIgnore) return [];
  if (args.ignore !== undefined) {
    return String(args.ignore)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_IGNORED_NAMES.slice();
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log([
      'Usage: node tools/duplicate-candidates/find-duplicate-candidates.mjs [options]',
      '',
      'Options:',
      '  --src DIR        source root to scan            (default: <repo>/src)',
      '  --report FILE    markdown report path           (default: reports/duplicate-candidates.md)',
      '  --ext a,b,c      scan these extensions          (default: .ts,.tsx,.mts,.cts,',
      '                                                   .js,.jsx,.mjs,.cjs)',
      '                   replaces the default list; .vue/.svelte are NOT scanned',
      '                   (single-file components need a real extractor)',
      '  --max N          max pairs printed per tier     (default: 60; the report always has all)',
      '  --ignore a,b,c   replace the default ubiquitous-name ignore list',
      '  --no-ignore      disable ubiquitous-name filtering entirely',
      '  --generated VAL  stamp the report with VAL (a date, a git SHA, …);',
      '                   omitted by default so two runs are byte-identical',
      '  -h, --help       show this help',
      '',
      'The ubiquitous-name filter only affects the default stdout listing: ignored',
      'pairs are counted in the summary and always written to the report.',
    ].join('\n'));
    return;
  }

  const srcRoot = path.resolve(args.src || DEFAULT_SRC);
  const reportPath = path.resolve(args.report || DEFAULT_REPORT);

  if (!fs.existsSync(srcRoot)) {
    console.error(`error: source root not found: ${srcRoot}`);
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = scanTree(srcRoot, {
      displayBase: path.dirname(srcRoot),
      extensions: resolveExtensions(args),
    });
  } catch (err) {
    console.error(`error: scan failed: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
    return;
  }

  const tiers = groupCandidates(result.functions, { ignoreList: resolveIgnoreList(args) });
  const parsedMax = Number.parseInt(args.max, 10);
  const text = renderStdout(result, tiers, reportPath, {
    displayBase: path.dirname(srcRoot),
    maxPrint: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined,
  });
  process.stdout.write(text);

  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      renderMarkdown(result, tiers, {
        displayBase: path.dirname(srcRoot),
        generated: args.generated,
      }),
      'utf8',
    );
  } catch (err) {
    console.error(`error: could not write report ${reportPath}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Finding candidates is success, not failure.
  process.exitCode = 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
