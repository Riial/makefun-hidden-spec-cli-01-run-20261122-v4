// mend v4 — one patch tool for every AI edit format.
//
// Implements SPEC.md v1 in full: unified diffs (section 6), SEARCH/REPLACE
// blocks (section 7), V4A patches (section 8) and JSON edits (section 9),
// over the three line-matching tiers of section 5, with the all-or-nothing
// write and the exit codes/output of sections 1, 2 and 10. Node 22,
// standard library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC section 3): split at \n, one trailing \r removed. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own break style (SPEC section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree, moves: [string, string][]) => void;

// ---- Matching lines (SPEC section 5) ----

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function lineEq(a: string, b: string, tier: 0 | 1 | 2): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}
function occurrences(fileLines: string[], O: string[], tier: 0 | 1 | 2): number[] {
  const out: number[] = [];
  const k = O.length;
  if (k === 0) return out;
  for (let i = 0; i + k <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(fileLines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier at which O occurs at least once, with its positions. */
function findTier(fileLines: string[], O: string[], strict: boolean): { tier: 0 | 1 | 2; positions: number[] } | null {
  const tiers: (0 | 1 | 2)[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(fileLines, O, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

// ---- Old/new line pairs ----

interface OLine {
  t: string;
}
interface NLine {
  t: string;
  /** Index into O for a context line, null for an added line. */
  o: number | null;
}
interface BodyEntry {
  k: 'ctx' | 'old' | 'new' | 'bs';
  t: string;
}

/** Split a hunk/chunk body into its old lines O and new lines N. */
function splitON(body: BodyEntry[]): { O: OLine[]; N: NLine[] } {
  const O: OLine[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.k === 'ctx') {
      N.push({ t: b.t, o: O.length });
      O.push({ t: b.t });
    } else if (b.k === 'old') {
      O.push({ t: b.t });
    } else if (b.k === 'new') {
      N.push({ t: b.t, o: null });
    }
  }
  return { O, N };
}

/** True when a `\` line follows the body's last context or added line. */
function noEolOf(body: BodyEntry[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.k === 'ctx' || body[i]!.k === 'new') return body[i + 1]?.k === 'bs';
  }
  return false;
}

/**
 * The replacement lines for a match at `pos`: context lines are the file's
 * own matched lines, and at tier 2 every other line is re-indented from
 * O's first line's leading whitespace to the file's (section 5).
 */
function buildN(O: OLine[], N: NLine[], fileLines: string[], pos: number, tier: 0 | 1 | 2): string[] {
  const out: string[] = [];
  const F = tier === 2 ? leadWs(fileLines[pos]!) : '';
  const P = tier === 2 ? leadWs(O[0]!.t) : '';
  for (const n of N) {
    if (n.o !== null) {
      out.push(fileLines[pos + n.o]!);
    } else if (tier === 2 && n.t !== '' && n.t.trim() !== '' && n.t.startsWith(P)) {
      out.push(F + n.t.slice(P.length));
    } else {
      out.push(n.t);
    }
  }
  return out;
}

// ---- Format detection (SPEC section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines.some((l) => l.trim() === '*** Begin Patch')) return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Unified diffs (SPEC section 6) ----

interface Hunk {
  A: number;
  body: BodyEntry[];
  O: OLine[];
  N: NLine[];
  noEol: boolean;
}
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, spaces removed, a/ or b/ stripped. */
function cleanDiffPath(s: string): string | null {
  const cut = s.split('\t')[0]!;
  const t = cut.replace(/^ +| +$/g, '');
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

function makeHunk(A: number, raw: string[]): Hunk {
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const body: BodyEntry[] = raw.map((l) => {
    if (l === '') return { k: 'ctx', t: '' } as BodyEntry;
    const c = l[0]!;
    if (c === ' ') return { k: 'ctx', t: l.slice(1) } as BodyEntry;
    if (c === '-') return { k: 'old', t: l.slice(1) } as BodyEntry;
    if (c === '+') return { k: 'new', t: l.slice(1) } as BodyEntry;
    return { k: 'bs', t: l.slice(1) } as BodyEntry;
  });
  const { O, N } = splitON(body);
  return { A, body, O, N, noEol: noEolOf(body) };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const fresh = (): Section => {
    const s: Section = {
      gitOld: null,
      gitNew: null,
      oldPath: null,
      newPath: null,
      hasPair: false,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = fresh();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.hasPair) fresh();
      cur!.oldPath = cleanDiffPath(line.slice(4));
      cur!.newPath = cleanDiffPath(lines[i + 1]!.slice(4));
      cur!.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(hm[1]!, 10);
      let j = i + 1;
      const raw: string[] = [];
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          raw.push(bl);
          j++;
        } else {
          break;
        }
      }
      cur.hunks.push(makeHunk(A, raw));
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyHunk(state: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const O = h.O.map((o) => o.t);
  if (O.length === 0) {
    const at = Math.max(0, Math.min(h.A + d, state.lines.length));
    const atEnd = at === state.lines.length;
    const ins = h.N.map((x) => x.t);
    const lines = state.lines.slice();
    lines.splice(at, 0, ...ins);
    return { lines, br: state.br, final: atEnd ? !h.noEol : state.final };
  }
  const found = findTier(state.lines, O, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.A - 1 + d;
  let best = found.positions[0]!;
  let bd = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bd) {
      best = p;
      bd = dist;
    }
  }
  const touchesEnd = best + O.length === state.lines.length;
  const repl = buildN(h.O, h.N, state.lines, best, found.tier);
  const lines = state.lines.slice();
  lines.splice(best, O.length, ...repl);
  return { lines, br: state.br, final: touchesEnd ? !h.noEol : state.final };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree, moves) => {
    let oldP: string | null;
    let newP: string | null;
    if (sec.hasPair) {
      oldP = sec.oldPath;
      newP = sec.newPath;
    } else {
      oldP = sec.renameFrom !== null ? sec.renameFrom : sec.gitOld;
      newP = sec.renameTo !== null ? sec.renameTo : sec.gitNew;
    }
    const create = sec.newFile || oldP === null;
    const del = !create && (sec.delFile || newP === null);
    if (create) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (let bi = 0; bi < h.body.length; bi++) {
          if (h.body[bi]!.k === 'new') {
            plus.push(h.body[bi]!.t);
            noEol = h.body[bi + 1]?.k === 'bs';
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (del) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const oldPath = oldP!;
    const newPath = newP!;
    const isMove = oldPath !== newPath;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let state = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      state = applyHunk(state, h, d, strict, oldPath);
      d += h.N.length - h.O.length;
    }
    const outText = joinFile(state);
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, outText);
      moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, outText);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let k = searchIdx + 1;
    let eqIdx = -1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '=======') {
        eqIdx = k;
        break;
      }
      k++;
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let m = eqIdx + 1;
    let repIdx = -1;
    while (m < lines.length) {
      if (lines[m]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = m;
        break;
      }
      m++;
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = repIdx + 1;
    i = repIdx + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const state = splitFile(before);
    const found = findTier(state.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const F = found.tier === 2 ? leadWs(state.lines[pos]!) : '';
    const P = found.tier === 2 ? leadWs(oldLines[0]!) : '';
    const built = newLines.map((t) => {
      if (found.tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
      return t;
    });
    state.lines.splice(pos, oldLines.length, ...built);
    tree.now.set(path, joinFile(state));
  };
}

// ---- V4A patches (SPEC section 8) ----

function isV4aHeader(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

interface V4aChunk {
  anchor: string | null;
  O: OLine[];
  N: NLine[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      let j = i + 1;
      while (j < end && !isV4aHeader(lines[j]!)) j++;
      const raw = lines.slice(i + 1, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (!(l.startsWith('+') || l === '')) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      const fileLines = raw.map((l) => (l === '' ? '' : l.slice(1)));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < end && !isV4aHeader(lines[j]!)) j++;
      const raw = lines.slice(i + 1, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      let j = i + 1;
      while (j < end && !isV4aHeader(lines[j]!)) j++;
      const raw = lines.slice(i + 1, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      let k = 0;
      let moveTo: string | null = null;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let curBody: BodyEntry[] | null = null;
      let curAnchor: string | null = null;
      let curEof = false;
      const flush = () => {
        if (curBody !== null) {
          const { O, N } = splitON(curBody);
          chunks.push({ anchor: curAnchor, O, N, eof: curEof });
          curBody = null;
          curAnchor = null;
          curEof = false;
        }
      };
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          flush();
          const a = l.slice(2).trim();
          curAnchor = a === '' ? null : a;
          curBody = [];
          curEof = false;
        } else if (l === '*** End of File') {
          if (curBody === null) throw new Exit2(`error: parse ${i + 2 + k}`);
          curEof = true;
          flush();
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curBody === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 2 + k}`);
            curAnchor = null;
            curBody = [];
            curEof = false;
          }
          if (l === '') curBody.push({ k: 'ctx', t: '' });
          else if (l[0] === ' ') curBody.push({ k: 'ctx', t: l.slice(1) });
          else if (l[0] === '-') curBody.push({ k: 'old', t: l.slice(1) });
          else curBody.push({ k: 'new', t: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${i + 2 + k}`);
        }
      }
      flush();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

/** First line at or after `cursor` equal to a single-line anchor, tier by tier. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers: (0 | 1 | 2)[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let j = cursor; j < lines.length; j++) {
      if (lineEq(lines[j]!, anchor, t)) return j;
    }
  }
  return -1;
}

/** First occurrence of O at or after `cursor`, tier by tier (end-of-file chunks: only one ending at the last line). */
function findFrom(lines: string[], O: string[], cursor: number, strict: boolean, eof: boolean): { pos: number; tier: 0 | 1 | 2 } | null {
  const tiers: (0 | 1 | 2)[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i + O.length <= lines.length; i++) {
      if (eof && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!lineEq(lines[i + j]!, O[j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) return { pos: i, tier: t };
    }
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree, moves) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const state = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const j = findAnchor(state.lines, ch.anchor, cursor, strict);
        if (j < 0) throw new Fail('no-match', path);
        cursor = j + 1;
      }
      const O = ch.O.map((o) => o.t);
      if (O.length === 0) {
        const at = ch.eof ? state.lines.length : cursor;
        const ins = ch.N.map((x) => x.t);
        state.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findFrom(state.lines, O, cursor, strict, ch.eof);
        if (!found) throw new Fail('no-match', path);
        const repl = buildN(ch.O, ch.N, state.lines, found.pos, found.tier);
        state.lines.splice(found.pos, O.length, ...repl);
        cursor = found.pos + repl.length;
      }
    }
    const outText = joinFile(state);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, outText);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, outText);
    }
  };
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Running (SPEC sections 1, 2, 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: [string, string][] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const usedR = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      usedR.add(oldP);
      usedR.add(newP);
    }
  }
  const sortedPaths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of sortedPaths) {
    if (usedR.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of sortedPaths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
