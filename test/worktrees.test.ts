import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git';
import { defaultWorktreePath, getWorktrees, otherWorktree, parseWorktrees } from '../src/worktrees';

test('parseWorktrees reads branch, detached, locked, prunable and bare entries', () => {
  const out = [
    'worktree /src/app',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /src/app-feature',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feature/x',
    'locked reason here',
    '',
    'worktree /src/app-detached',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
    'worktree /src/bare.git',
    'bare',
    '',
  ].join('\n');
  assert.deepEqual(parseWorktrees(out), [
    { path: '/src/app', head: '1111111111111111111111111111111111111111', branch: 'main', detached: false, locked: false, prunable: false },
    { path: '/src/app-feature', head: '2222222222222222222222222222222222222222', branch: 'feature/x', detached: false, locked: true, prunable: false },
    { path: '/src/app-detached', head: '3333333333333333333333333333333333333333', branch: null, detached: true, locked: false, prunable: true },
  ]);
  assert.deepEqual(parseWorktrees(''), []);
});

test('defaultWorktreePath: sibling folder named after the repo and branch', () => {
  assert.equal(defaultWorktreePath('/src/app', 'feature/login'), join('/src', 'app-feature-login'));
  assert.equal(defaultWorktreePath('/src/app', 'fix: weird*name'), join('/src', 'app-fix-weird-name'));
});

test('getWorktrees lists linked worktrees; otherWorktree finds a branch checked out elsewhere', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'commit-graph-wt-')));
  const main = join(root, 'app');
  const g = (...args: string[]) => git(root, ['-c', 'user.name=T', '-c', 'user.email=t@t', '-C', main, ...args]);
  try {
    await git(root, ['init', '-q', '-b', 'main', main]);
    writeFileSync(join(main, 'a.txt'), 'a\n');
    await g('add', '.');
    await g('commit', '-q', '-m', 'root');
    const head = (await g('rev-parse', 'HEAD')).trim();
    await g('branch', 'feature');
    await g('worktree', 'add', '-q', join(root, 'app-feature'), 'feature');
    await g('worktree', 'add', '-q', '--detach', join(root, 'app-detached'), 'HEAD');
    await g('worktree', 'lock', join(root, 'app-feature'));

    const list = await getWorktrees(main);
    assert.deepEqual(
      list.map((w) => [w.path, w.branch, w.detached, w.locked, w.head === head]),
      [
        [main, 'main', false, false, true],
        [join(root, 'app-detached'), null, true, false, true],
        [join(root, 'app-feature'), 'feature', false, true, true],
      ],
    );
    assert.equal(otherWorktree(list, 'feature', main)?.path, join(root, 'app-feature'));
    assert.equal(otherWorktree(list, 'main', main), undefined); // checked out here
    assert.equal(otherWorktree(list, 'main', join(root, 'app-feature'))?.path, main);
    assert.equal(otherWorktree(list, 'nope', main), undefined);
    await g('worktree', 'unlock', join(root, 'app-feature'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
