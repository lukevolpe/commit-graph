import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHead, getStashes, git, gitAtLeast, stashPushArgs } from '../src/git';
import { classifyReflog, planUndo } from '../src/undo';

test('classifyReflog recognises undoable reflog subjects', () => {
  const k = (s: string) => {
    const a = classifyReflog(s);
    return a && { kind: a.kind, label: a.label, ...(a.from ? { from: a.from } : {}), ...(a.to ? { to: a.to } : {}), ...(a.branch ? { branch: a.branch } : {}) };
  };
  assert.deepEqual(k('commit: fix login'), { kind: 'commit', label: 'commit “fix login”' });
  assert.deepEqual(k('commit (amend): fix login'), { kind: 'amend', label: 'amend of “fix login”' });
  assert.deepEqual(k('commit (merge): Merge branch f'), { kind: 'merge', label: 'merge commit “Merge branch f”' });
  assert.deepEqual(k('checkout: moving from main to feature/x'), {
    kind: 'checkout',
    label: 'switch from main to feature/x',
    from: 'main',
    to: 'feature/x',
  });
  assert.deepEqual(k('checkout: moving from main to 1a2b3c4d5e6f'), {
    kind: 'checkout',
    label: 'switch from main to 1a2b3c4d5e6f',
    from: 'main',
    to: '1a2b3c4d5e6f',
  });
  assert.deepEqual(k('reset: moving to HEAD~1'), { kind: 'reset', label: 'reset to HEAD~1' });
  assert.deepEqual(k('merge feature: Fast-forward'), { kind: 'merge', label: 'merge of feature' });
  assert.deepEqual(k("merge origin/main: Merge made by the 'ort' strategy."), { kind: 'merge', label: 'merge of origin/main' });
  assert.deepEqual(k('rebase (finish): returning to refs/heads/main'), { kind: 'rebase', label: 'rebase of main', branch: 'main' });
  assert.deepEqual(k('rebase -i (finish): returning to refs/heads/a/b'), { kind: 'rebase', label: 'rebase of a/b', branch: 'a/b' });
  assert.deepEqual(k('pull --rebase (finish): returning to refs/heads/main'), { kind: 'pull', label: 'pull (rebase) into main', branch: 'main' });
  assert.deepEqual(k('pull: Fast-forward'), { kind: 'pull', label: 'pull' });
  assert.deepEqual(k("pull --no-rebase: Merge made by the 'ort' strategy."), { kind: 'pull', label: 'pull' });
  assert.deepEqual(k('cherry-pick: add thing'), { kind: 'cherry-pick', label: 'cherry-pick of “add thing”' });
  assert.deepEqual(k('revert: Revert "add thing"'), { kind: 'revert', label: 'revert “Revert "add thing"”' });

  // Not safely undoable: first commit, mid-rebase steps, unknown actions.
  for (const s of [
    'commit (initial): root',
    'rebase (start): checkout main',
    'rebase (pick): two',
    'rebase -i (pick): two',
    'pull --rebase (start): checkout origin/main',
    'clone: from https://x/y.git',
    'branch: Created from HEAD',
    'am: patch',
    '',
  ]) {
    assert.equal(classifyReflog(s), null, s);
  }
});

// ---- against a real repo ------------------------------------------------------

let dir: string;
const g = (...args: string[]) => git(dir, ['-c', 'user.name=Test User', '-c', 'user.email=t@t', ...args]);
const head = async () => (await getHead(dir))!;
const branch = async () => (await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim();

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'commit-graph-undo-'));
  await g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 'root');
  appendFileSync(join(dir, 'a.txt'), 'b\n');
  await g('commit', '-q', '-am', 'second');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('undo a commit moves the branch back and keeps it checked out', async () => {
  const before = await head();
  writeFileSync(join(dir, 'new.txt'), 'n\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 'oops');
  const plan = await planUndo(dir);
  assert.ok(!('error' in plan), JSON.stringify(plan));
  assert.equal(plan.action.kind, 'commit');
  assert.equal(plan.branch, 'main');
  assert.equal(plan.target, before);
  assert.equal(plan.pushed, 0);
  await g(...plan.args);
  assert.equal(await head(), before);
  assert.equal(await branch(), 'main');
  assert.ok(!existsSync(join(dir, 'new.txt')));
});

test('undo an amend restores the original commit', async () => {
  const before = await head();
  await g('commit', '-q', '--amend', '-m', 'second, reworded');
  const plan = await planUndo(dir);
  assert.ok(!('error' in plan));
  assert.equal(plan.action.kind, 'amend');
  await g(...plan.args);
  assert.equal(await head(), before);
});

test('undo a checkout switches back to the previous branch', async () => {
  await g('branch', 'other');
  await g('switch', '-q', 'other');
  const plan = await planUndo(dir);
  assert.ok(!('error' in plan));
  assert.equal(plan.action.kind, 'checkout');
  assert.deepEqual(plan.args, ['switch', 'main']);
  await g(...plan.args);
  assert.equal(await branch(), 'main');
  await g('branch', '-D', 'other');
});

test('undo a merge returns to before it', async () => {
  const before = await head();
  await g('switch', '-q', '-c', 'side');
  writeFileSync(join(dir, 'side.txt'), 's\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 'side work');
  await g('switch', '-q', 'main');
  await g('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const plan = await planUndo(dir);
  assert.ok(!('error' in plan));
  assert.equal(plan.action.kind, 'merge');
  await g(...plan.args);
  assert.equal(await head(), before);
  await g('branch', '-D', 'side');
});

test('undo a rebase returns the branch to its pre-rebase tip', async () => {
  const base = await head();
  await g('switch', '-q', '-c', 'topic');
  writeFileSync(join(dir, 't1.txt'), '1\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 't1');
  writeFileSync(join(dir, 't2.txt'), '2\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 't2');
  const before = await head();
  await g('switch', '-q', 'main');
  appendFileSync(join(dir, 'a.txt'), 'm\n');
  await g('commit', '-q', '-am', 'main moves');
  await g('switch', '-q', 'topic');
  await g('rebase', '-q', 'main');
  const plan = await planUndo(dir);
  assert.ok(!('error' in plan), JSON.stringify(plan));
  assert.equal(plan.action.kind, 'rebase');
  assert.equal(plan.target, before);
  await g(...plan.args);
  assert.equal(await head(), before);
  await g('switch', '-q', 'main');
  await g('reset', '-q', '--hard', base);
  await g('branch', '-D', 'topic');
});

test('undo refuses when uncommitted changes would be overwritten', async () => {
  appendFileSync(join(dir, 'a.txt'), 'c\n');
  await g('commit', '-q', '-am', 'third');
  appendFileSync(join(dir, 'a.txt'), 'dirty\n');
  const plan = await planUndo(dir);
  assert.ok(!('error' in plan));
  await assert.rejects(g(...plan.args));
  await g('checkout', '--', 'a.txt');
  await g(...plan.args);
});

test('undo flags commits already on the upstream', async () => {
  const remote = mkdtempSync(join(tmpdir(), 'commit-graph-undo-remote-'));
  try {
    await git(remote, ['init', '-q', '--bare']);
    await g('remote', 'add', 'origin', remote);
    appendFileSync(join(dir, 'a.txt'), 'pushed\n');
    await g('commit', '-q', '-am', 'pushed one');
    await g('push', '-q', '-u', 'origin', 'main');
    const plan = await planUndo(dir);
    assert.ok(!('error' in plan));
    assert.equal(plan.pushed, 1);
    assert.equal(plan.upstream, 'origin/main');
  } finally {
    rmSync(remote, { recursive: true, force: true });
  }
});

test('undo says when there is nothing it can undo', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'commit-graph-undo-fresh-'));
  try {
    await git(fresh, ['init', '-q', '-b', 'main']);
    writeFileSync(join(fresh, 'x'), 'x\n');
    await git(fresh, ['add', '.']);
    await git(fresh, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'root']);
    const plan = await planUndo(fresh);
    assert.ok('error' in plan);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('stashPushArgs builds stash push for tracked, untracked and staged-only', async () => {
  assert.deepEqual(stashPushArgs({}), ['stash', 'push']);
  assert.deepEqual(stashPushArgs({ message: ' wip ', untracked: true }), ['stash', 'push', '--include-untracked', '-m', 'wip']);
  assert.deepEqual(stashPushArgs({ staged: true }), ['stash', 'push', '--staged']);
  assert.equal(gitAtLeast('git version 2.35.1', 2, 35), true);
  assert.equal(gitAtLeast('git version 2.34.9.windows.1', 2, 35), false);
  assert.equal(gitAtLeast('git version 3.0.0', 2, 35), true);
  assert.equal(gitAtLeast('nonsense', 2, 35), false);

  appendFileSync(join(dir, 'a.txt'), 'tracked change\n');
  writeFileSync(join(dir, 'loose.txt'), 'u\n');
  try {
    await g(...stashPushArgs({ message: 'tracked only' }));
    let stashes = await getStashes(dir);
    assert.deepEqual(stashes.map((s) => s.subject), ['tracked only']);
    assert.ok(existsSync(join(dir, 'loose.txt')), 'untracked file left alone without -u');

    await g(...stashPushArgs({ untracked: true }));
    stashes = await getStashes(dir);
    assert.equal(stashes.length, 2);
    assert.ok(!existsSync(join(dir, 'loose.txt')), 'untracked file stashed with -u');
  } finally {
    await g('stash', 'clear');
  }
});
