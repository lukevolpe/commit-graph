/** A search box query split into AND-ed terms. All strings are lowercased. */
export interface ParsedQuery {
  /** Plain words or "quoted phrases": message, author, email or SHA prefix. */
  text: string[];
  message: string[];
  /** Name or email substring. */
  author: string[];
  /** SHA prefixes. */
  sha: string[];
  /** Paths or globs; resolved with git, not against the index. */
  files: string[];
  /** Unix seconds, inclusive. */
  after?: number;
  /** Unix seconds, exclusive. */
  before?: number;
  /** true: merges only; false: non-merges only. */
  merge?: boolean;
}

/** One-line operator help, for the search box tooltip. */
export const SEARCH_HELP = [
  'Words match message, author, email or SHA. All terms must match.',
  'author:ada  author:"Ada L"',
  'message:fix',
  'file:src/git.ts  file:*.css',
  'after:2026-01-01  before:2026-06-01  after:2w (d, w, m, y)',
  'type:merge  type:nonmerge',
  '#abc123  sha:abc123',
].join('\n');

const DAY = 86400;
const REL_UNIT: Record<string, number> = { h: 3600, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY };

/**
 * Parses `after:` / `before:` values: ISO dates (local time) or relative
 * ages like `2w` (counted back from `now`, in ms). undefined when invalid.
 */
export function parseDate(s: string, now = Date.now()): number | undefined {
  const rel = s.match(/^(\d+)\s*([hdwmy])$/i);
  if (rel) return Math.floor(now / 1000) - Number(rel[1]) * REL_UNIT[rel[2].toLowerCase()];
  const ymd = s.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
  if (ymd) {
    const [y, m, d] = [Number(ymd[1]), Number(ymd[2] ?? 1), Number(ymd[3] ?? 1)];
    const t = new Date(y, m - 1, d);
    if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) return undefined;
    return Math.floor(t.getTime() / 1000);
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d/.test(s)) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

/** Splits on whitespace, keeping `"quoted phrases"` and `key:"quoted values"` whole. */
function tokens(q: string): { key?: string; value: string }[] {
  const out: { key?: string; value: string }[] = [];
  const re = /(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi;
  for (const m of q.matchAll(re)) {
    const value = m[2] ?? m[3] ?? '';
    out.push({ key: m[1]?.toLowerCase(), value });
  }
  return out;
}

/**
 * Parses a search query. Never throws: unknown `foo:` keys and invalid
 * operator values are kept as plain text; empty operators (`author:`) are ignored.
 */
export function parseQuery(query: string, now = Date.now()): ParsedQuery {
  const q: ParsedQuery = { text: [], message: [], author: [], sha: [], files: [] };
  const plain = (s: string) => {
    const t = s.trim().toLowerCase();
    if (t) q.text.push(t);
  };
  for (const { key, value } of tokens(query)) {
    const v = value.trim();
    const lv = v.toLowerCase();
    const raw = `${key}:${v}`;
    switch (key) {
      case undefined: {
        const half = lv.match(/^([a-z]+):$/); // `author:` mid-typing
        if (half && KNOWN.has(half[1])) break;
        if (/^#[0-9a-f]+$/.test(lv)) q.sha.push(lv.slice(1));
        else plain(v);
        break;
      }
      case 'author':
        if (lv) q.author.push(lv);
        break;
      case 'message':
      case 'msg':
        if (lv) q.message.push(lv);
        break;
      case 'sha':
      case 'hash':
        if (/^[0-9a-f]+$/.test(lv)) q.sha.push(lv);
        else plain(raw);
        break;
      case 'file':
      case 'path':
        if (v) q.files.push(v);
        break;
      case 'after':
      case 'since':
      case 'before':
      case 'until': {
        const t = parseDate(v, now);
        if (t === undefined) plain(raw);
        else if (key === 'after' || key === 'since') q.after = Math.max(q.after ?? t, t);
        else q.before = Math.min(q.before ?? t, t);
        break;
      }
      case 'type':
      case 'is':
        if (lv === 'merge') q.merge = true;
        else if (lv === 'nonmerge' || lv === 'non-merge' || lv === 'commit') q.merge = false;
        else plain(raw);
        break;
      default:
        plain(raw);
    }
  }
  return q;
}

const KNOWN = new Set(['author', 'message', 'msg', 'sha', 'hash', 'file', 'path', 'after', 'since', 'before', 'until', 'type', 'is']);

/** True when the query constrains nothing (empty, or only half-typed operators). */
export function isEmptyQuery(q: ParsedQuery): boolean {
  return (
    !q.text.length &&
    !q.message.length &&
    !q.author.length &&
    !q.sha.length &&
    !q.files.length &&
    q.after === undefined &&
    q.before === undefined &&
    q.merge === undefined
  );
}

/**
 * git pathspecs for a `file:` term. Bare names match at any depth
 * (`file:git.ts`, `file:*.css`); a leading `/` anchors to the repo root.
 * A directory matches everything under it.
 */
export function filePathspecs(pattern: string): string[] {
  let p = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const anchored = p.startsWith('/');
  p = p.replace(/^\/+/, '');
  if (!p) return [];
  if (!anchored && !p.includes('/') && !p.startsWith('**')) p = '**/' + p;
  return [`:(top,glob,icase)${p}`, `:(top,glob,icase)${p}/**`];
}
