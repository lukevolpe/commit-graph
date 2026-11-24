import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOperation, git, gitNoEditor } from '../src/git';

let dir: string;
const g = (...args: string[]) => git(dir, ['-c', 'user.name=Test User', '-c', 'user.email=t@t', ...args]);
const fails = async (...args: string[]) => assert.ok(await g(...args).then(() => false, () => true), `${args[0]} should stop`);
const commit = async (file: string, text: string, msg: string) => {
  writeFileSync(join(dir, file), text);
  await g('add', '.');
  await g('commit', '-q', '-m', msg);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'commit-graph-op-'));
  await g('init', '-q', '-b', 'main');
  await commit('a.txt', 'base\n', 'root');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('no operation in progress', async () => {
  assert.equal(await getOperation(dir), null);
});

test('conflicting merge: source, target, conflicted files; updates as files are resolved', async () => {
  await g('checkout', '-q', '-b', 'feature/x');
  await commit('a.txt', 'feature\n', 'feature edit');
  await commit('b.txt', 'feature b\n', 'feature b');
  await g('checkout', '-q', 'main');
  await commit('a.txt', 'main\n', 'main edit');
  await commit('b.txt', 'main b\n', 'main b');
  await fails('merge', 'feature/x');

  const op = await getOperation(dir);
  assert.deepEqual(op, { kind: 'merge', head: 'main', incoming: 'feature/x', conflicts: ['a.txt', 'b.txt'] });

  writeFileSync(join(dir, 'a.txt'), 'resolved\n');
  await g('add', 'a.txt');
  assert.deepEqual((await getOperation(dir))?.conflicts, ['b.txt']);

  await g('merge', '--abort');
  assert.equal(await getOperation(dir), null);
});

test('conflicting rebase: branch, onto, step of total', async () => {
  await g('checkout', '-q', '-b', 'feature');
  await commit('f1.txt', '1\n', 'f1');
  await commit('a.txt', 'feature\n', 'f2 conflicts');
  await commit('f3.txt', '3\n', 'f3');
  await g('checkout', '-q', 'main');
  await commit('a.txt', 'main\n', 'main edit');
  await g('checkout', '-q', 'feature');
  await fails('rebase', 'main');

  const op = await getOperation(dir);
  assert.deepEqual(op, { kind: 'rebase', head: 'feature', incoming: 'main', step: 2, total: 3, conflicts: ['a.txt'] });
  await g('rebase', '--abort');
  assert.equal(await getOperation(dir), null);
});

test('rebase with the apply backend reads rebase-apply', async () => {
  await g('checkout', '-q', '-b', 'feature');
  await commit('a.txt', 'feature\n', 'f1 conflicts');
  await commit('f2.txt', '2\n', 'f2');
  await g('checkout', '-q', 'main');
  await commit('a.txt', 'main\n', 'main edit');
  await g('checkout', '-q', 'feature');
  await fails('rebase', '--apply', 'main');

  const op = await getOperation(dir);
  assert.equal(op?.kind, 'rebase');
  assert.equal(op?.head, 'feature');
  assert.equal(op?.step, 1);
  assert.equal(op?.total, 2);
  assert.deepEqual(op?.conflicts, ['a.txt']);
});

test('conflicting cherry-pick and revert name the commit', async () => {
  await g('checkout', '-q', '-b', 'side');
  await commit('a.txt', 'side\n', 'side edit');
  const pick = (await g('rev-parse', 'HEAD')).trim();
  await g('checkout', '-q', 'main');
  await commit('a.txt', 'main\n', 'main edit');
  await fails('cherry-pick', pick);
  assert.deepEqual(await getOperation(dir), {
    kind: 'cherry-pick',
    head: 'main',
    incoming: pick.slice(0, 7),
    subject: 'side edit',
    conflicts: ['a.txt'],
  });
  await g('cherry-pick', '--abort');

  await commit('a.txt', 'main 2\n', 'main edit 2');
  const prev = (await g('rev-parse', 'HEAD~1')).trim();
  await fails('revert', '--no-edit', prev);
  const op = await getOperation(dir);
  assert.equal(op?.kind, 'revert');
  assert.equal(op?.incoming, prev.slice(0, 7));
  assert.equal(op?.subject, 'main edit');
  assert.deepEqual(op?.conflicts, ['a.txt']);
});

test('bisect in progress', async () => {
  await commit('a.txt', '2\n', 'two');
  await commit('a.txt', '3\n', 'three');
  await g('bisect', 'start');
  await g('bisect', 'bad');
  await g('bisect', 'good', 'HEAD~2');
  const op = await getOperation(dir);
  assert.equal(op?.kind, 'bisect');
  assert.equal(op?.head, 'main');
  assert.deepEqual(op?.conflicts, []);
  await g('bisect', 'reset');
  assert.equal(await getOperation(dir), null);
});

test('continue runs without an editor once conflicts are resolved', async () => {
  await g('checkout', '-q', '-b', 'side');
  await commit('a.txt', 'side\n', 'side edit');
  await g('checkout', '-q', 'main');
  await commit('a.txt', 'main\n', 'main edit');
  await fails('merge', 'side');
  writeFileSync(join(dir, 'a.txt'), 'both\n');
  await g('add', 'a.txt');
  process.env.GIT_EDITOR = 'false'; // an editor that fails: continue must not use it
  try {
    await gitNoEditor(dir, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'merge', '--continue']);
  } finally {
    delete process.env.GIT_EDITOR;
  }
  assert.equal(await getOperation(dir), null);
  assert.equal((await g('log', '-1', '--format=%s')).trim(), "Merge branch 'side'");
});
