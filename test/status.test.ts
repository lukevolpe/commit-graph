import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, discard, getStatus, git, lastMessage, parseStatus, stage, unstage } from '../src/git';

const H = 'a'.repeat(40);
const I = 'b'.repeat(40);

test('parseStatus splits porcelain v2 into staged and unstaged', () => {
  const out = [
    `1 MM N... 100644 100644 100644 ${H} ${I} src/both.ts`,
    `1 A. N... 000000 100644 100644 ${H} ${I} added file.txt`,
    `1 .D N... 100644 100644 000000 ${H} ${I} gone.txt`,
    `2 RM N... 100644 100644 100644 ${H} ${I} R90 new name.ts`,
    'old name.ts',
    `u UU N... 100644 100644 100644 100644 ${H} ${I} ${H} conflict.ts`,
    '? notes/todo.md',
    '! ignored.log',
    '',
  ].join('\0');
  const s = parseStatus(out);
  const show = (fs: typeof s.staged) =>
    fs.map((f) => `${f.status} ${f.oldPath ? f.oldPath + ' -> ' : ''}${f.path}${f.untracked ? ' (untracked)' : ''}`);
  assert.deepEqual(show(s.staged), ['M src/both.ts', 'A added file.txt', 'R old name.ts -> new name.ts']);
  assert.deepEqual(show(s.unstaged), [
    'M src/both.ts',
    'D gone.txt',
    'M new name.ts',
    'U conflict.ts',
    'A notes/todo.md (untracked)',
  ]);
  assert.deepEqual(parseStatus(''), { staged: [], unstaged: [] });
});

// ---- against a real repo ------------------------------------------------------

let dir: string;
const g = (...args: string[]) => git(dir, args);
const show = (fs: { status: string; path: string; oldPath?: string; untracked?: boolean }[]) =>
  fs.map((f) => `${f.status} ${f.oldPath ? f.oldPath + ' -> ' : ''}${f.path}${f.untracked ? ' (untracked)' : ''}`);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'commit-graph-status-'));
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.name', 'Test User');
  await g('config', 'user.email', 't@t');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'bee\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 'root');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('getStatus reports staged and unstaged sides with line counts', async () => {
  appendFileSync(join(dir, 'a.txt'), 'two\n');
  await g('add', 'a.txt');
  appendFileSync(join(dir, 'a.txt'), 'three\nfour\n');
  writeFileSync(join(dir, 'new file.txt'), 'x\n');
  const s = await getStatus(dir);
  assert.deepEqual(show(s.staged), ['M a.txt']);
  assert.deepEqual([s.staged[0].added, s.staged[0].deleted], [1, 0]);
  assert.deepEqual(show(s.unstaged), ['M a.txt', 'A new file.txt (untracked)']);
  assert.deepEqual([s.unstaged[0].added, s.unstaged[0].deleted], [2, 0]);
  await g('reset', '-q', '--hard');
  rmSync(join(dir, 'new file.txt'));
  assert.deepEqual(await getStatus(dir), { staged: [], unstaged: [] });
});

test('stage and unstage handle edits, deletions, untracked files and renames', async () => {
  appendFileSync(join(dir, 'a.txt'), 'two\n');
  rmSync(join(dir, 'b.txt'));
  writeFileSync(join(dir, 'c.txt'), 'see\n');
  await stage(dir, ['a.txt', 'b.txt', 'c.txt']);
  let s = await getStatus(dir);
  assert.deepEqual(show(s.staged), ['M a.txt', 'D b.txt', 'A c.txt']);
  assert.deepEqual(s.unstaged, []);

  await unstage(dir, ['c.txt', 'a.txt']);
  s = await getStatus(dir);
  assert.deepEqual(show(s.staged), ['D b.txt']);
  assert.deepEqual(show(s.unstaged), ['M a.txt', 'A c.txt (untracked)']);
  await g('reset', '-q', '--hard');
  rmSync(join(dir, 'c.txt'));

  await g('mv', 'a.txt', 'z.txt');
  s = await getStatus(dir);
  assert.deepEqual(show(s.staged), ['R a.txt -> z.txt']);
  await unstage(dir, ['a.txt', 'z.txt']);
  s = await getStatus(dir);
  assert.deepEqual(s.staged, []);
  assert.deepEqual(show(s.unstaged), ['D a.txt', 'A z.txt (untracked)']);
  await g('reset', '-q', '--hard');
  rmSync(join(dir, 'z.txt'));
});

test('discard restores unstaged edits and deletions, keeps staged ones, deletes untracked files', async () => {
  appendFileSync(join(dir, 'a.txt'), 'staged\n');
  await stage(dir, ['a.txt']);
  appendFileSync(join(dir, 'a.txt'), 'unstaged\n');
  rmSync(join(dir, 'b.txt'));
  writeFileSync(join(dir, 'junk.txt'), 'j\n');
  const before = await getStatus(dir);
  assert.deepEqual(show(before.unstaged), ['M a.txt', 'D b.txt', 'A junk.txt (untracked)']);
  await discard(dir, before.unstaged);
  const s = await getStatus(dir);
  assert.deepEqual([show(s.staged), s.unstaged], [['M a.txt'], []]);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\nstaged\n');
  assert.ok(existsSync(join(dir, 'b.txt')));
  assert.ok(!existsSync(join(dir, 'junk.txt')));
  await g('reset', '-q', '--hard');
});

test('commit: staged only, all tracked (-a), amend keeps one commit', async () => {
  appendFileSync(join(dir, 'a.txt'), 'staged\n');
  appendFileSync(join(dir, 'b.txt'), 'not staged\n');
  await stage(dir, ['a.txt']);
  await commit(dir, 'Add staged line\n\nBody text');
  assert.equal(await lastMessage(dir), 'Add staged line\n\nBody text');
  assert.deepEqual(show((await getStatus(dir)).unstaged), ['M b.txt']);

  writeFileSync(join(dir, 'untracked.txt'), 'u\n');
  await commit(dir, 'Commit all tracked', { all: true });
  assert.deepEqual(show((await getStatus(dir)).unstaged), ['A untracked.txt (untracked)']);
  const count = async () => (await g('rev-list', '--count', 'HEAD')).trim();
  const n = await count();

  await stage(dir, ['untracked.txt']);
  await commit(dir, 'Commit all tracked, amended', { amend: true });
  assert.equal(await count(), n);
  assert.equal(await lastMessage(dir), 'Commit all tracked, amended');
  assert.deepEqual(await getStatus(dir), { staged: [], unstaged: [] });

  await assert.rejects(commit(dir, 'nothing to commit'));
});

test('unstage works before the first commit', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'commit-graph-unborn-'));
  try {
    await git(fresh, ['init', '-q']);
    writeFileSync(join(fresh, 'x.txt'), 'x\n');
    await stage(fresh, ['x.txt']);
    assert.deepEqual(show((await getStatus(fresh)).staged), ['A x.txt']);
    await unstage(fresh, ['x.txt']);
    const s = await getStatus(fresh);
    assert.deepEqual([s.staged, show(s.unstaged)], [[], ['A x.txt (untracked)']]);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});
