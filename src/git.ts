import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { ParsedQuery, filePathspecs, isEmptyQuery, parseQuery } from './search';

export type RefKind = 'head' | 'branch' | 'remote' | 'tag';

export interface Ref {
  name: string;
  kind: RefKind;
  /** Branch HEAD points at. */
  current?: boolean;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds. */
  date: number;
  refs: Ref[];
  subject: string;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface FileChange {
  status: FileStatus;
  /** Repo-relative, posix. */
  path: string;
  /** Set for renames and copies. */
  oldPath?: string;
  /** null for binary files. */
  added: number | null;
  deleted: number | null;
  /** New file git doesn't track yet (working tree only). */
  untracked?: boolean;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  committer: string;
  committerEmail: string;
  committerDate: number;
  message: string;
  files: FileChange[];
}

/** Which refs the graph shows. */
export type Scope = 'all' | 'current';

/** Hash of git's empty tree: diff base for root commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const FIELD = '\x1f';
const RECORD = '\x1e';
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f') + '%x1e';

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

/** Per-worktree git dir (HEAD, index) and shared dir (refs). */
export async function gitDirs(cwd: string): Promise<{ gitDir: string; commonDir: string }> {
  const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  const [gitDir, commonDir] = out.trim().split('\n');
  return { gitDir, commonDir: commonDir || gitDir };
}

/** null when the repo has no commits yet. */
export async function getHead(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

function scopeArgs(scope: Scope): string[] {
  // Not --all: that drags in stash and notes commits.
  return scope === 'all' ? ['--branches', '--remotes', '--tags', 'HEAD'] : ['HEAD'];
}

/** Revisions to walk, or null when there is nothing to show. */
async function revArgs(cwd: string, scope: Scope): Promise<string[] | null> {
  if (await getHead(cwd)) return scopeArgs(scope);
  // Unborn HEAD: other refs may still exist.
  return scope === 'all' ? ['--branches', '--remotes', '--tags'] : null;
}

/** `file`: repo-relative path; only commits touching it (see fileHistoryArgs). */
export async function getLog(cwd: string, scope: Scope, skip: number, limit: number, file?: string): Promise<Commit[]> {
  const revs = await revArgs(cwd, scope);
  if (!revs) return [];
  const args = ['log', '--topo-order', '--decorate=full', `--format=${LOG_FORMAT}`, `--skip=${skip}`, `-n${limit}`];
  if (file) return parseLog(await git(cwd, [...args, ...fileHistoryArgs(), ...revs, '--', `:(literal)${file}`]));
  return parseLog(await git(cwd, [...args, ...revs, '--']));
}

/**
 * Path-limited walk that still draws as a graph: --parents makes %P the rewritten
 * parents (nearest shown ancestors), --full-history keeps side branches that touched
 * the file, --simplify-merges drops merges that add nothing. Not --follow (it can't
 * rewrite parents or walk several refs), so history stops at a rename.
 */
function fileHistoryArgs(): string[] {
  return ['--full-history', '--simplify-merges', '--parents'];
}

// ---- line history & blame ------------------------------------------------------

/** Commits that changed lines `start`–`end` (1-based) of `file`, newest first. From HEAD. */
export async function getLineHistory(cwd: string, file: string, start: number, end: number): Promise<string[]> {
  const out = await git(cwd, ['log', '-s', '--format=%H', `-L${start},${end}:${file}`, 'HEAD']);
  return out.split('\n').filter((l) => /^[0-9a-f]{40}$/.test(l));
}

/** Commit that last changed line `line` (1-based) of `file`; null when uncommitted or untracked. */
export async function getBlameCommit(cwd: string, file: string, line: number): Promise<string | null> {
  try {
    return parseBlameCommit(await git(cwd, ['blame', '--porcelain', `-L${line},${line}`, '--', file]));
  } catch {
    return null;
  }
}

/** First commit hash in `git blame --porcelain` output; null for the all-zero "not committed yet". */
export function parseBlameCommit(out: string): string | null {
  const h = out.match(/^([0-9a-f]{40}) /)?.[1];
  return h && !/^0+$/.test(h) ? h : null;
}

export function parseLog(out: string): Commit[] {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, parents, author, email, date, refs, subject] = r.split(FIELD);
      return {
        hash,
        parents: splitParents(parents),
        author,
        email,
        date: Number(date),
        refs: parseRefs(refs),
        subject: subject ?? '',
      };
    });
}

function splitParents(p: string | undefined): string[] {
  return p ? p.split(' ').filter(Boolean) : [];
}

/** Parses `%D` output from `--decorate=full`. */
export function parseRefs(d: string | undefined): Ref[] {
  if (!d) return [];
  const refs: Ref[] = [];
  for (const part of d.split(', ')) {
    if (part === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head' }); // detached
    } else if (part.startsWith('HEAD -> ')) {
      const r = toRef(part.slice('HEAD -> '.length));
      if (r) refs.push({ ...r, current: true });
    } else if (part.startsWith('tag: ')) {
      const r = toRef(part.slice('tag: '.length));
      if (r) refs.push(r);
    } else {
      const r = toRef(part);
      if (r) refs.push(r);
    }
  }
  return refs;
}

function toRef(full: string): Ref | null {
  if (full.startsWith('refs/heads/')) return { name: full.slice(11), kind: 'branch' };
  if (full.startsWith('refs/tags/')) return { name: full.slice(10), kind: 'tag' };
  if (full.startsWith('refs/remotes/')) {
    if (full.endsWith('/HEAD')) return null; // origin/HEAD is noise
    return { name: full.slice(13), kind: 'remote' };
  }
  return null;
}

export async function getDetails(cwd: string, hash: string): Promise<CommitDetails> {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f');
  const out = await git(cwd, ['show', '-s', `--format=${fmt}`, hash, '--']);
  const [h, parents, author, email, date, committer, committerEmail, committerDate, ...msg] = out.split(FIELD);
  const ps = splitParents(parents);
  return {
    hash: h,
    parents: ps,
    author,
    email,
    date: Number(date),
    committer,
    committerEmail,
    committerDate: Number(committerDate),
    message: msg.join(FIELD).trimEnd(),
    // Merges are shown against their first parent, like most tools.
    files: await getChanges(cwd, ps[0] ?? EMPTY_TREE, h),
  };
}

/** Changes between two revisions, or from a revision to the working tree when `to` is omitted. */
export async function getChanges(cwd: string, from: string, to?: string): Promise<FileChange[]> {
  const diff = (mode: string) =>
    git(cwd, ['diff', mode, '-z', '-M', '--no-color', '--no-ext-diff', from, ...(to ? [to] : []), '--']);
  const [names, nums] = await Promise.all([diff('--name-status'), diff('--numstat')]);
  return mergeChanges(parseNameStatus(names), parseNumstat(nums));
}

/** Uncommitted changes (staged + unstaged vs HEAD) plus untracked files. */
export async function getWorkingChanges(cwd: string): Promise<FileChange[]> {
  const [tracked, untracked] = await Promise.all([
    getChanges(cwd, 'HEAD'),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const extra: FileChange[] = untracked
    .split('\0')
    .filter(Boolean)
    .map((path) => ({ status: 'A', path, added: null, deleted: null, untracked: true }));
  return [...tracked, ...extra];
}

export function parseNameStatus(out: string): Omit<FileChange, 'added' | 'deleted'>[] {
  const t = out.split('\0');
  const files: Omit<FileChange, 'added' | 'deleted'>[] = [];
  let i = 0;
  while (i < t.length) {
    const s = t[i++];
    if (!s) continue;
    const status = s[0] as FileStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = t[i++];
      files.push({ status, oldPath, path: t[i++] });
    } else {
      files.push({ status, path: t[i++] });
    }
  }
  return files;
}

export function parseNumstat(out: string): Map<string, { added: number | null; deleted: number | null }> {
  const t = out.split('\0');
  const map = new Map<string, { added: number | null; deleted: number | null }>();
  let i = 0;
  while (i < t.length) {
    const s = t[i++];
    if (!s) continue;
    const [a, d, p] = s.split('\t');
    let path = p;
    if (p === '') {
      i++; // old path
      path = t[i++];
    }
    map.set(path, { added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d) });
  }
  return map;
}

function mergeChanges(
  names: Omit<FileChange, 'added' | 'deleted'>[],
  nums: Map<string, { added: number | null; deleted: number | null }>,
): FileChange[] {
  return names.map((f) => ({ ...f, ...(nums.get(f.path) ?? { added: null, deleted: null }) }));
}

// ---- sync state (ahead / behind upstream) --------------------------------------

export interface Tracking {
  upstream: string;
  ahead: number;
  behind: number;
  /** Upstream branch was deleted on the remote. */
  gone: boolean;
}

export interface SyncState {
  /** Checked-out branch; null when detached or unborn. */
  branch: string | null;
  /** Tracking info for the checked-out branch, if it has an upstream. */
  current: Tracking | null;
  /** Remote to publish to when the branch has no upstream. */
  remote: string | null;
  /** Commits on HEAD not on its upstream (to push), newest first. */
  outgoing: string[];
  /** Commits on the upstream not on HEAD (to pull), newest first. */
  incoming: string[];
  /** Local branch name → tracking info, for branches that have an upstream. */
  tracking: Record<string, Tracking>;
}

/** Most marked rows per direction: a far-diverged branch shouldn't stall a refresh. */
const SYNC_LIMIT = 2000;

/** Parses `%(upstream:track,nobracket)`: "ahead 2, behind 1", "gone" or "". */
export function parseTrack(s: string): Omit<Tracking, 'upstream'> {
  return {
    ahead: Number(s.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(s.match(/behind (\d+)/)?.[1] ?? 0),
    gone: s.trim() === 'gone',
  };
}

export async function getSync(cwd: string): Promise<SyncState> {
  const fmt = ['%(HEAD)', '%(refname)', '%(upstream:short)', '%(upstream:track,nobracket)'].join('%00');
  const [refs, remotes] = await Promise.all([
    git(cwd, ['for-each-ref', `--format=${fmt}`, 'refs/heads']),
    git(cwd, ['remote']),
  ]);
  const tracking: Record<string, Tracking> = {};
  let branch: string | null = null;
  for (const line of refs.split('\n')) {
    if (!line) continue;
    const [head, ref, upstream, track] = line.split('\0');
    const name = ref.replace(/^refs\/heads\//, '');
    if (head === '*') branch = name;
    if (upstream) tracking[name] = { upstream, ...parseTrack(track ?? '') };
  }
  const names = remotes.split('\n').filter(Boolean);
  const current = branch ? (tracking[branch] ?? null) : null;
  let outgoing: string[] = [];
  let incoming: string[] = [];
  if (current && !current.gone && (current.ahead || current.behind)) {
    const list = async (range: string) =>
      (await git(cwd, ['rev-list', `--max-count=${SYNC_LIMIT}`, range, '--'])).split('\n').filter(Boolean);
    [outgoing, incoming] = await Promise.all([
      current.ahead ? list('@{upstream}..HEAD') : [],
      current.behind ? list('HEAD..@{upstream}') : [],
    ]);
  }
  return {
    branch,
    current,
    remote: names.includes('origin') ? 'origin' : (names[0] ?? null),
    outgoing,
    incoming,
    tracking,
  };
}

export interface SearchEntry {
  hash: string;
  /** Lowercased message + author + email. */
  text: string;
  /** Lowercased "name email"; `text` starts with it. */
  author?: string;
  /** Unix seconds (author date). */
  date?: number;
  parents?: number;
}

/** Everything search needs, in graph order. Built once per refresh. */
export async function getSearchIndex(cwd: string, scope: Scope, file?: string): Promise<SearchEntry[]> {
  const revs = await revArgs(cwd, scope);
  if (!revs) return [];
  const fmt = ['%H', '%P', '%at', '%an', '%ae', '%B'].join('%x1f') + '%x1e';
  const limit = file ? [...fileHistoryArgs(), ...revs, '--', `:(literal)${file}`] : [...revs, '--'];
  const out = await git(cwd, ['log', '--topo-order', `--format=${fmt}`, ...limit]);
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, parents, date, name, email, ...msg] = r.split(FIELD);
      const author = `${name} ${email}`.toLowerCase();
      return {
        hash,
        text: author + ' ' + msg.join(' ').toLowerCase(),
        author,
        date: Number(date),
        parents: splitParents(parents).length,
      };
    });
}

/**
 * Matches every term of the query (AND): plain words against message, author,
 * email or hash prefix, plus operators (see parseQuery). `files` is the set of
 * commits matching the query's `file:` terms, from getFileMatches.
 */
export function search(index: SearchEntry[], query: string | ParsedQuery, files?: Set<string>): string[] {
  const q = typeof query === 'string' ? parseQuery(query) : query;
  if (isEmptyQuery(q)) return [];
  const hit = (e: SearchEntry) => {
    for (const t of q.text) {
      const hex = /^[0-9a-f]{4,40}$/.test(t);
      if (!(hex && e.hash.startsWith(t)) && !e.text.includes(t)) return false;
    }
    const msgStart = e.author ? e.author.length + 1 : 0;
    for (const t of q.message) if (e.text.indexOf(t, msgStart) < 0) return false;
    for (const t of q.author) if (!(e.author ?? e.text).includes(t)) return false;
    for (const t of q.sha) if (!e.hash.startsWith(t)) return false;
    if (q.after !== undefined && !((e.date ?? 0) >= q.after)) return false;
    if (q.before !== undefined && !((e.date ?? Infinity) < q.before)) return false;
    if (q.merge !== undefined && (e.parents ?? 0) > 1 !== q.merge) return false;
    if (q.files.length && files && !files.has(e.hash)) return false;
    return true;
  };
  return index.filter(hit).map((e) => e.hash);
}

/** Most commits one `file:` term returns: keeps a broad glob on a huge repo bounded. */
export const FILE_MATCH_LIMIT = 20000;

/**
 * Commits in scope touching a path or glob (see filePathspecs). A merge counts
 * when it changes the path vs its first parent, matching the details pane.
 */
export async function getFileMatches(cwd: string, scope: Scope, pattern: string): Promise<Set<string>> {
  const revs = await revArgs(cwd, scope);
  const specs = filePathspecs(pattern);
  if (!revs || !specs.length) return new Set();
  const base = ['log', '--full-history', `--max-count=${FILE_MATCH_LIMIT}`];
  const tail = [...revs, '--', ...specs];
  let out: string;
  try {
    out = await git(cwd, [...base, '--format=%x1e%H%x1f%P', '--name-only', '--diff-merges=first-parent', ...tail]);
  } catch {
    // git < 2.31: no --diff-merges; keep any merge git lists.
    return new Set((await git(cwd, [...base, '--format=%H', ...tail])).split('\n').filter(Boolean));
  }
  const hits = new Set<string>();
  for (const r of out.split(RECORD)) {
    const [hash, rest = ''] = r.split(FIELD);
    if (!hash) continue;
    const [parents, ...names] = rest.split('\n');
    if (splitParents(parents).length < 2 || names.some(Boolean)) hits.add(hash.trim());
  }
  return hits;
}

/** Web URL for a commit on GitHub, GitLab, Bitbucket and similar hosts. */
export function commitWebUrl(remoteUrl: string, hash: string): string | undefined {
  const base = remoteWebBase(remoteUrl);
  if (!base) return undefined;
  const host = new URL(base).hostname;
  if (host.includes('bitbucket')) return `${base}/commits/${hash}`;
  if (host.includes('gitlab')) return `${base}/-/commit/${hash}`;
  return `${base}/commit/${hash}`;
}

export function remoteWebBase(remoteUrl: string): string | undefined {
  const s = remoteUrl.trim().replace(/\/$/, '').replace(/\.git$/, '');
  const proto = s.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (proto) return `https://${proto[1]}/${proto[2]}`;
  const scp = s.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  return undefined;
}

// ---- stashes ---------------------------------------------------------------------

/** A stash entry drawn as a row. `parents` holds only the base commit. */
export interface Stash extends Commit {
  /** Reflog selector, e.g. `stash@{0}`. Shifts as stashes come and go: resolve by hash before acting. */
  stash: string;
}

const STASH_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%gd', '%s'].join('%x1f') + '%x1e';

/** Newest first. Empty when there are no stashes. */
export async function getStashes(cwd: string): Promise<Stash[]> {
  return parseStashes(await git(cwd, ['stash', 'list', `--format=${STASH_FORMAT}`]));
}

export function parseStashes(out: string): Stash[] {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, parents, author, email, date, selector, subject] = r.split(FIELD);
      // 2nd/3rd parents hold the index and untracked files: not part of the graph.
      const base = splitParents(parents)[0];
      return {
        hash,
        parents: base ? [base] : [],
        author,
        email,
        date: Number(date),
        refs: [],
        // "On main: my message" → "my message". "WIP on main: abc123 subject" stays as is.
        subject: (subject ?? '').replace(/^On [^:]+: /, ''),
        stash: selector,
      };
    });
}

/**
 * Puts each stash directly above its base commit (newest stash on top). Stashes whose base
 * isn't in `commits` are left out: they belong to a later page, or are out of scope.
 */
export function insertStashes<T extends { hash: string }>(commits: T[], stashes: Stash[]): (T | Stash)[] {
  if (!stashes.length) return commits;
  const byBase = new Map<string, Stash[]>();
  for (const s of stashes) {
    const b = s.parents[0];
    if (b) byBase.set(b, [...(byBase.get(b) ?? []), s]);
  }
  return commits.flatMap((c) => [...(byBase.get(c.hash) ?? []), c]);
}

/** Current `stash@{n}` for a stash commit, or null if it's gone. */
export async function stashSelector(cwd: string, hash: string): Promise<string | null> {
  return (await getStashes(cwd)).find((s) => s.hash === hash)?.stash ?? null;
}

/** Stash details: changes against its base, plus untracked files if it saved any. */
export async function getStashDetails(cwd: string, hash: string): Promise<CommitDetails> {
  const d = await getDetails(cwd, hash);
  const untrackedCommit = d.parents[2];
  const untracked = untrackedCommit
    ? (await getChanges(cwd, EMPTY_TREE, untrackedCommit)).map((f) => ({ ...f, untracked: true }))
    : [];
  return { ...d, parents: d.parents.slice(0, 1), files: [...d.files, ...untracked] };
}

export interface StashPushOptions {
  message?: string;
  /** Also stash untracked files (`-u`). */
  untracked?: boolean;
  /** Only what's staged (`--staged`, git 2.35+). */
  staged?: boolean;
}

/** Arguments for `git stash push` with the given options. */
export function stashPushArgs({ message, untracked, staged }: StashPushOptions): string[] {
  const args = ['stash', 'push'];
  if (untracked) args.push('--include-untracked');
  if (staged) args.push('--staged');
  if (message?.trim()) args.push('-m', message.trim());
  return args;
}

/** True if `git version` output is at least major.minor. */
export function gitAtLeast(versionOut: string, major: number, minor: number): boolean {
  const m = /(\d+)\.(\d+)/.exec(versionOut);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}

// ---- operation in progress (merge, rebase, cherry-pick, revert, bisect) ----------

export type OperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface Operation {
  kind: OperationKind;
  /** Branch being merged into / rebased / bisected; null when detached. */
  head: string | null;
  /** What comes in: merged branch, rebase onto, short SHA being picked or reverted. */
  incoming?: string | null;
  /** Subject of the commit being cherry-picked or reverted. */
  subject?: string;
  /** Rebase progress: current step and total. */
  step?: number;
  total?: number;
  /** Files with unresolved conflicts, repo-relative. */
  conflicts: string[];
}

/** The merge, rebase, cherry-pick, revert or bisect in progress, or null. Read from the git dir. */
export async function getOperation(cwd: string): Promise<Operation | null> {
  const { gitDir } = await gitDirs(cwd);
  const read = (f: string) => readFile(joinPath(gitDir, f), 'utf8').then((s) => s.trim(), () => null);
  const num = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : undefined);
  const branchName = (ref: string | null) => (ref && ref.startsWith('refs/heads/') ? ref.slice(11) : null);
  const current = async () => {
    try {
      return (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null;
    } catch {
      return null;
    }
  };
  const conflicts = async () =>
    (await git(cwd, ['diff', '--name-only', '-z', '--diff-filter=U'])).split('\0').filter(Boolean);
  const commit = async (sha: string) => ({
    incoming: sha.slice(0, 7),
    subject: (await git(cwd, ['log', '-1', '--format=%s', sha, '--']).catch(() => '')).trim(),
  });

  for (const d of ['rebase-merge', 'rebase-apply']) {
    const headName = await read(`${d}/head-name`);
    if (headName === null) continue;
    if ((await read(`${d}/applying`)) !== null) break; // `git am`, not a rebase
    const merge = d === 'rebase-merge';
    const onto = await read(`${d}/onto`);
    return {
      kind: 'rebase',
      head: branchName(headName),
      incoming: onto ? await refNameFor(cwd, onto) : null,
      step: num(await read(merge ? `${d}/msgnum` : `${d}/next`)),
      total: num(await read(merge ? `${d}/end` : `${d}/last`)),
      conflicts: await conflicts(),
    };
  }
  const mergeHead = await read('MERGE_HEAD');
  if (mergeHead) {
    const msg = (await read('MERGE_MSG')) ?? '';
    const m = msg.match(/^Merge (?:remote-tracking )?(?:branch|tag|commit) '([^']+)'/);
    return {
      kind: 'merge',
      head: await current(),
      incoming: m ? m[1] : mergeHead.split('\n')[0].slice(0, 7),
      conflicts: await conflicts(),
    };
  }
  for (const [file, kind] of [['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
    const sha = await read(file);
    if (sha) return { kind, head: await current(), ...(await commit(sha)), conflicts: await conflicts() };
  }
  if ((await read('BISECT_LOG')) !== null) {
    const start = await read('BISECT_START');
    return { kind: 'bisect', head: start && !/^[0-9a-f]{40}$/.test(start) ? start : null, conflicts: [] };
  }
  return null;
}

/** A branch name pointing at `sha` (local first), else its short SHA. */
async function refNameFor(cwd: string, sha: string): Promise<string> {
  try {
    const out = await git(cwd, ['for-each-ref', '--points-at', sha, '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
    const name = out.split('\n').find((n) => n && !n.endsWith('/HEAD'));
    if (name) return name;
  } catch {
    // fall through
  }
  return sha.slice(0, 7);
}

/** Runs git with no editor, so `--continue` and merges never wait on one. */
export function gitNoEditor(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.editor=true', ...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || stdout.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}
