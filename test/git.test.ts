import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitWebUrl,
  getChanges,
  getDetails,
  getFileMatches,
  getHead,
  getLog,
  getSearchIndex,
  getSync,
  getWorkingChanges,
  git,
  parseNameStatus,
  parseNumstat,
  parseRefs,
  parseTrack,
  search,
} from '../src/git';
import { GraphLayout } from '../src/lanes';
import { parseQuery } from '../src/search';

test('parseRefs handles branches, remotes, tags, HEAD', () => {
  assert.deepEqual(
    parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1, refs/stash'),
    [
      { name: 'main', kind: 'branch', current: true },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v1', kind: 'tag' },
    ],
  );
  assert.deepEqual(parseRefs('HEAD'), [{ name: 'HEAD', kind: 'head' }]);
  assert.deepEqual(parseRefs(''), []);
});

test('parseNameStatus and parseNumstat handle renames (-z format)', () => {
  const names = parseNameStatus('M\0src/a.ts\0R087\0old.ts\0new.ts\0A\0bin.png\0');
  assert.deepEqual(names, [
    { status: 'M', path: 'src/a.ts' },
    { status: 'R', oldPath: 'old.ts', path: 'new.ts' },
    { status: 'A', path: 'bin.png' },
  ]);
  const nums = parseNumstat('3\t1\tsrc/a.ts\0' + '2\t2\t\0old.ts\0new.ts\0' + '-\t-\tbin.png\0');
  assert.deepEqual(nums.get('src/a.ts'), { added: 3, deleted: 1 });
  assert.deepEqual(nums.get('new.ts'), { added: 2, deleted: 2 });
  assert.deepEqual(nums.get('bin.png'), { added: null, deleted: null });
});

test('commitWebUrl understands ssh, https and scp-style remotes', () => {
  const h = 'abc123';
  assert.equal(commitWebUrl('git@github.com:o/r.git', h), 'https://github.com/o/r/commit/abc123');
  assert.equal(commitWebUrl('https://github.com/o/r.git', h), 'https://github.com/o/r/commit/abc123');
  assert.equal(commitWebUrl('ssh://git@gitlab.com:2222/g/sub/r.git', h), 'https://gitlab.com/g/sub/r/-/commit/abc123');
  assert.equal(commitWebUrl('https://me@bitbucket.org/o/r.git', h), 'https://bitbucket.org/o/r/commits/abc123');
  assert.equal(commitWebUrl('not a url', h), undefined);
});

test('parseTrack reads ahead, behind and gone', () => {
  assert.deepEqual(parseTrack('ahead 2, behind 13'), { ahead: 2, behind: 13, gone: false });
  assert.deepEqual(parseTrack('behind 1'), { ahead: 0, behind: 1, gone: false });
  assert.deepEqual(parseTrack('gone'), { ahead: 0, behind: 0, gone: true });
  assert.deepEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false });
});

test('search matches message, author and hash prefix in order', () => {
  const index = [
    { hash: 'aaaa1111', text: 'fix login bug alice a@x' },
    { hash: 'bbbb2222', text: 'add feature bob b@x' },
    { hash: 'cccc3333', text: 'bobcat thing carol c@x' },
  ];
  assert.deepEqual(search(index, 'BOB'), ['bbbb2222', 'cccc3333']);
  assert.deepEqual(search(index, 'cccc'), ['cccc3333']);
  assert.deepEqual(search(index, '  '), []);
});

// ---- against a real repo ------------------------------------------------------

let dir: string;
const g = (...args: string[]) => git(dir, ['-c', 'user.name=Test User', '-c', 'user.email=t@t', ...args]);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'commit-graph-'));
  await g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'readme.md'), 'hello\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 'root');
  await g('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'feature.txt'), 'one\ntwo\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 'feature work', '-m', 'Longer body\nline two');
  await g('checkout', '-q', 'main');
  appendFileSync(join(dir, 'readme.md'), 'more\n');
  await g('commit', '-q', '-am', 'main work | with "odd" chars');
  await g('merge', '-q', '--no-ff', 'feature', '-m', 'merge feature');
  await g('tag', 'v1');
  await g('stash', 'list'); // no-op; stash refs must never show up
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('reads log with branches, merge and tags', async () => {
  const commits = await getLog(dir, 'all', 0, 100);
  assert.equal(commits.length, 4);
  assert.equal(commits[0].subject, 'merge feature');
  assert.equal(commits[0].parents.length, 2);
  assert.deepEqual(commits[0].refs, [
    { name: 'main', kind: 'branch', current: true },
    { name: 'v1', kind: 'tag' },
  ]);
  assert.ok(commits.some((c) => c.subject === 'main work | with "odd" chars'));
  assert.equal(commits[3].parents.length, 0);

  const rows = new GraphLayout().add(commits);
  assert.deepEqual(rows.map((r) => r.col), [0, 1, 0, 0]);

  const page2 = await getLog(dir, 'all', 2, 100);
  assert.deepEqual(page2.map((c) => c.hash), commits.slice(2).map((c) => c.hash));
});

test('current scope hides unrelated branches', async () => {
  await g('branch', 'side', 'HEAD~1');
  await g('checkout', '-q', 'side');
  await g('commit', '-q', '--allow-empty', '-m', 'side only');
  await g('checkout', '-q', 'main');
  const all = await getLog(dir, 'all', 0, 100);
  const cur = await getLog(dir, 'current', 0, 100);
  assert.ok(all.some((c) => c.subject === 'side only'));
  assert.ok(!cur.some((c) => c.subject === 'side only'));
  await g('branch', '-D', 'side');
});

test('details: full message and files, merge compared with first parent', async () => {
  const [merge, feature] = await getLog(dir, 'all', 0, 2);
  const d = await getDetails(dir, feature.hash);
  assert.equal(d.message, 'feature work\n\nLonger body\nline two');
  assert.deepEqual(d.files, [{ status: 'A', path: 'feature.txt', added: 2, deleted: 0 }]);

  const m = await getDetails(dir, merge.hash);
  assert.deepEqual(m.files.map((f) => f.path), ['feature.txt']);

  const root = (await getLog(dir, 'all', 0, 100)).at(-1)!;
  const r = await getDetails(dir, root.hash);
  assert.deepEqual(r.files, [{ status: 'A', path: 'readme.md', added: 1, deleted: 0 }]);
});

test('working changes include modified, deleted and untracked files', async () => {
  appendFileSync(join(dir, 'readme.md'), 'wip\n');
  writeFileSync(join(dir, 'new.txt'), 'x\n');
  await g('rm', '-q', 'feature.txt');
  const files = await getWorkingChanges(dir);
  assert.deepEqual(
    files.map((f) => `${f.status} ${f.path}`).sort(),
    ['A new.txt', 'D feature.txt', 'M readme.md'],
  );
  await g('reset', '-q', '--hard');
  rmSync(join(dir, 'new.txt'));
  assert.deepEqual(await getWorkingChanges(dir), []);
});

test('renames are detected between revisions', async () => {
  await g('mv', 'feature.txt', 'renamed.txt');
  await g('commit', '-q', '-m', 'rename');
  const files = await getChanges(dir, 'HEAD~1', 'HEAD');
  assert.deepEqual(files, [{ status: 'R', oldPath: 'feature.txt', path: 'renamed.txt', added: 0, deleted: 0 }]);
});

test('search index covers bodies and authors', async () => {
  const index = await getSearchIndex(dir, 'all');
  const head = await getHead(dir);
  assert.equal(index[0].hash, head);
  assert.equal(search(index, 'longer body').length, 1);
  assert.equal(search(index, 'test user').length, index.length);
});

test('empty repo returns nothing instead of failing', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'commit-graph-empty-'));
  try {
    await git(empty, ['init', '-q']);
    assert.equal(await getHead(empty), null);
    assert.deepEqual(await getLog(empty, 'all', 0, 10), []);
    assert.deepEqual(await getLog(empty, 'current', 0, 10), []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('sync state: ahead, behind, gone upstream and publish remote', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commit-graph-sync-'));
  const remote = join(root, 'remote.git');
  const a = join(root, 'a');
  const b = join(root, 'b');
  const ga = (...args: string[]) => git(a, ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
  const gb = (...args: string[]) => git(b, ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
  try {
    await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
    await git(root, ['clone', '-q', remote, a]);
    await ga('commit', '-q', '--allow-empty', '-m', 'one');
    await ga('push', '-q', '-u', 'origin', 'main');

    let s = await getSync(a);
    assert.equal(s.branch, 'main');
    assert.equal(s.remote, 'origin');
    assert.deepEqual(s.current, { upstream: 'origin/main', ahead: 0, behind: 0, gone: false });

    // Someone else pushes; we commit locally.
    await git(root, ['clone', '-q', remote, b]);
    await gb('commit', '-q', '--allow-empty', '-m', 'theirs');
    await gb('push', '-q');
    await ga('commit', '-q', '--allow-empty', '-m', 'mine 1');
    await ga('commit', '-q', '--allow-empty', '-m', 'mine 2');
    await ga('fetch', '-q');
    s = await getSync(a);
    assert.deepEqual([s.current!.ahead, s.current!.behind], [2, 1]);
    assert.equal(s.outgoing.length, 2);
    assert.equal(s.outgoing[0], await getHead(a));
    assert.equal(s.incoming.length, 1);

    // A branch with no upstream; another whose upstream was deleted.
    await ga('branch', 'local-only');
    await ga('push', '-q', '-u', 'origin', 'main:doomed');
    await ga('branch', '-q', '--set-upstream-to=origin/doomed', 'local-only');
    await gb('push', '-q', 'origin', '--delete', 'doomed');
    await ga('fetch', '-q', '--prune');
    s = await getSync(a);
    assert.equal(s.tracking['local-only'].gone, true);
    await ga('switch', '-q', '-c', 'fresh');
    s = await getSync(a);
    assert.equal(s.branch, 'fresh');
    assert.equal(s.current, null);
    assert.deepEqual([s.outgoing, s.incoming], [[], []]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file search: paths, globs, directories, scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commit-graph-files-'));
  const h = (...args: string[]) => git(root, ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
  // Merges count when they change the path vs their first parent, like the details pane.
  try {
    await h('init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src', 'ui'), { recursive: true });
    writeFileSync(join(root, 'src', 'git.ts'), '1\n');
    await h('add', '.');
    await h('commit', '-q', '-m', 'add git.ts');
    writeFileSync(join(root, 'src', 'ui', 'Style.CSS'), 'a{}\n');
    await h('add', '.');
    await h('commit', '-q', '-m', 'add css');
    await h('checkout', '-q', '-b', 'side');
    appendFileSync(join(root, 'src', 'git.ts'), '2\n');
    await h('commit', '-q', '-am', 'side edit');
    await h('checkout', '-q', 'main');
    writeFileSync(join(root, 'top.css'), 'b{}\n');
    await h('add', '.');
    await h('commit', '-q', '-m', 'top css');
    await h('branch', 'later');
    await h('merge', '-q', '--no-ff', 'side', '-m', 'merge side');
    await h('checkout', '-q', 'later');

    const index = await getSearchIndex(root, 'all');
    const subj = async (q: string, scope: 'all' | 'current' = 'all') => {
      const parsed = parseQuery(q);
      const sets = await Promise.all(parsed.files.map((p) => getFileMatches(root, scope, p)));
      const files = sets.length ? new Set([...sets[0]].filter((x) => sets.every((s) => s.has(x)))) : undefined;
      const hits = new Set(search(index, parsed, files));
      return (await getLog(root, 'all', 0, 100)).filter((c) => hits.has(c.hash)).map((c) => c.subject);
    };
    assert.deepEqual(await subj('file:src/git.ts'), ['merge side', 'side edit', 'add git.ts']);
    assert.deepEqual(await subj('file:git.ts'), ['merge side', 'side edit', 'add git.ts']);
    assert.deepEqual(await subj('file:*.css'), ['top css', 'add css']);
    assert.deepEqual(await subj('file:/*.css'), ['top css']);
    assert.deepEqual(await subj('file:src/ui'), ['add css']);
    assert.deepEqual(await subj('file:SRC/UI/style.css'), ['add css']);
    assert.deepEqual(await subj('file:src'), ['merge side', 'side edit', 'add css', 'add git.ts']);
    assert.deepEqual(await subj('file:src side'), ['merge side', 'side edit']);
    assert.deepEqual(await subj('file:src file:*.css type:nonmerge'), ['add css']);
    assert.deepEqual(await subj('file:git.ts', 'current'), ['add git.ts']);
    assert.deepEqual(await subj('file:nope.txt'), []);
    assert.deepEqual(await subj('type:merge'), ['merge side']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
