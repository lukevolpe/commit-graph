import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git';
import { TodoRow, buildTodo, planRebase, rebaseInProgress, runRebase, validateTodo } from '../src/rebase';

/** Repo with `base` then commits B..E, each adding its own file (no conflicts). */
async function makeRepo(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'commit-graph-rebase-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (...args: string[]) => git(dir, args);
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.name', 'Test User');
  await g('config', 'user.email', 't@t');
  const sha: Record<string, string> = {};
  for (const name of ['base', 'B', 'C', 'D', 'E']) {
    writeFileSync(join(dir, `${name}.txt`), name);
    await g('add', '.');
    await g('commit', '-q', '-m', name);
    sha[name] = (await g('rev-parse', 'HEAD')).trim();
  }
  /** Commit messages base..HEAD, oldest first, each as "subject|body". */
  const log = async () =>
    (await g('log', '--reverse', '--format=%s|%b%x1e', `${sha.base}..HEAD`))
      .split('\x1e')
      .map((s) => s.trim())
      .filter(Boolean);
  const rows = (...spec: [string, TodoRow['action'], string?][]): TodoRow[] =>
    spec.map(([n, action, message]) => ({ sha: sha[n], action, message }));
  return { dir, g, sha, log, rows };
}

test('planRebase lists the commits after the clicked one, oldest first, and counts pushed ones', async (t) => {
  const r = await makeRepo(t);
  await r.g('commit', '-q', '--amend', '-m', 'E', '-m', 'E body');
  r.sha.E = (await r.g('rev-parse', 'HEAD')).trim();
  const plan = await planRebase(r.dir, r.sha.B);
  assert.ok(plan.ok);
  assert.equal(plan.branch, 'main');
  assert.equal(plan.pushed, 0);
  assert.deepEqual(
    plan.commits.map((c) => [c.hash, c.subject, c.message, c.author]),
    [
      [r.sha.C, 'C', 'C', 'Test User'],
      [r.sha.D, 'D', 'D', 'Test User'],
      [r.sha.E, 'E', 'E\n\nE body', 'Test User'],
    ],
  );
  assert.ok(plan.commits[0].date > 0);

  // Upstream (a local branch will do) has B and C.
  await r.g('branch', 'pub', r.sha.C);
  await r.g('branch', '--set-upstream-to=pub');
  const pushed = await planRebase(r.dir, r.sha.base);
  assert.ok(pushed.ok);
  assert.equal(pushed.pushed, 2);
  assert.equal(pushed.commits.length, 4);
});

test('planRebase refuses HEAD, commits off the current branch, merges and a rebase in progress', async (t) => {
  const r = await makeRepo(t);
  const reason = async (sha: string) => {
    const p = await planRebase(r.dir, sha);
    return p.ok ? '' : p.reason;
  };
  assert.match(await reason(r.sha.E), /HEAD/);

  await r.g('switch', '-q', '-c', 'side', r.sha.C);
  writeFileSync(join(r.dir, 'side.txt'), 'side');
  await r.g('add', '.');
  await r.g('commit', '-q', '-m', 'side');
  const side = (await r.g('rev-parse', 'HEAD')).trim();
  await r.g('switch', '-q', 'main');
  assert.match(await reason(side), /current branch/);

  await r.g('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  assert.match(await reason(r.sha.B), /merge/i);

  await r.g('reset', '-q', '--hard', r.sha.E);
  assert.equal(await runRebase(r.dir, r.sha.C, r.rows(['D', 'edit'], ['E', 'pick'])), 'stopped');
  assert.match(await reason(r.sha.B), /in progress/);
});

test('runRebase reorders commits', async (t) => {
  const r = await makeRepo(t);
  const status = await runRebase(r.dir, r.sha.base, r.rows(['D', 'pick'], ['B', 'pick'], ['E', 'pick'], ['C', 'pick']));
  assert.equal(status, 'done');
  assert.deepEqual(await r.log(), ['D|', 'B|', 'E|', 'C|']);
});

test('runRebase drops commits', async (t) => {
  const r = await makeRepo(t);
  await runRebase(r.dir, r.sha.base, r.rows(['B', 'pick'], ['C', 'drop'], ['D', 'pick'], ['E', 'drop']));
  assert.deepEqual(await r.log(), ['B|', 'D|']);
  assert.equal((await r.g('ls-files')).split('\n').filter(Boolean).sort().join(','), 'B.txt,D.txt,base.txt');
});

test('runRebase squashes (messages combined) and fixes up (message discarded)', async (t) => {
  const r = await makeRepo(t);
  await runRebase(r.dir, r.sha.base, r.rows(['B', 'pick'], ['C', 'squash'], ['D', 'pick'], ['E', 'fixup']));
  assert.deepEqual(await r.log(), ['B|C', 'D|']);
  // Folded commits keep their changes.
  assert.equal((await r.g('show', '--name-only', '--format=', 'HEAD')).trim().split('\n').sort().join(','), 'D.txt,E.txt');
});

test('runRebase rewords with a multi-line message, also when the next row folds into it', async (t) => {
  const r = await makeRepo(t);
  await runRebase(
    r.dir,
    r.sha.base,
    r.rows(['B', 'reword', "It's new\n\nWith a body\n# not a comment"], ['C', 'fixup'], ['D', 'pick'], ['E', 'pick']),
  );
  assert.deepEqual(await r.log(), ["It's new|With a body\n# not a comment", 'D|', 'E|']);
  assert.equal((await r.g('log', '-1', '--format=%an', 'HEAD~2')).trim(), 'Test User');
});

test('runRebase stops at edit as a normal rebase that --continue finishes', async (t) => {
  const r = await makeRepo(t);
  const status = await runRebase(r.dir, r.sha.base, r.rows(['B', 'edit'], ['C', 'reword', 'C2'], ['D', 'pick'], ['E', 'pick']));
  assert.equal(status, 'stopped');
  assert.equal(await rebaseInProgress(r.dir), true);
  assert.equal((await r.g('rev-parse', 'HEAD')).trim(), r.sha.B);
  await r.g('-c', 'core.editor=true', 'rebase', '--continue');
  // The reword after the stop still finds its message file.
  assert.deepEqual(await r.log(), ['B|', 'C2|', 'D|', 'E|']);
  assert.equal(await rebaseInProgress(r.dir), false);
});

test('runRebase reports conflicts as stopped and throws when git refuses to start', async (t) => {
  const r = await makeRepo(t);
  writeFileSync(join(r.dir, 'B.txt'), 'dirty');
  await assert.rejects(runRebase(r.dir, r.sha.base, r.rows(['C', 'pick'], ['B', 'pick'])), /unstaged|uncommitted|changes/i);
  assert.equal(await rebaseInProgress(r.dir), false);
  await r.g('checkout', '--', 'B.txt');

  // F edits B.txt; moving F before B conflicts.
  writeFileSync(join(r.dir, 'B.txt'), 'B changed');
  await r.g('commit', '-q', '-am', 'F');
  const F = (await r.g('rev-parse', 'HEAD')).trim();
  const rows: TodoRow[] = [{ sha: F, action: 'pick' }, ...r.rows(['B', 'pick'], ['C', 'pick'], ['D', 'pick'], ['E', 'pick'])];
  assert.equal(await runRebase(r.dir, r.sha.base, rows), 'stopped');
  await r.g('rebase', '--abort');
});

test('validateTodo rejects squash/fixup with nothing before it, empty rewords and an empty list', () => {
  assert.equal(validateTodo([{ sha: 'a', action: 'pick' }, { sha: 'b', action: 'squash' }]), null);
  assert.match(validateTodo([{ sha: 'a', action: 'fixup' }, { sha: 'b', action: 'pick' }])!, /first/i);
  // Dropped rows don't count as something to fold into.
  assert.match(validateTodo([{ sha: 'a', action: 'drop' }, { sha: 'b', action: 'squash' }])!, /first/i);
  assert.match(validateTodo([{ sha: 'a', action: 'reword', message: '  \n' }])!, /message/i);
  assert.match(validateTodo([])!, /no commits/i);
  // Dropping everything is allowed: the branch ends up at the base.
  assert.equal(validateTodo([{ sha: 'a', action: 'drop' }]), null);
});

test('buildTodo writes one line per row in order; reword becomes pick + amend exec', () => {
  const todo = buildTodo(
    [
      { sha: 'aaa', action: 'pick' },
      { sha: 'bbb', action: 'reword', message: 'New\n\nbody' },
      { sha: 'ccc', action: 'squash' },
      { sha: 'ddd', action: 'fixup' },
      { sha: 'eee', action: 'edit' },
      { sha: 'fff', action: 'drop' },
    ],
    (row) => `/tmp/it's/${row.sha}.msg`,
  );
  assert.equal(
    todo,
    [
      'pick aaa',
      'pick bbb',
      `exec git commit --amend --only --no-verify --allow-empty -F '/tmp/it'\\''s/bbb.msg'`,
      'squash ccc',
      'fixup ddd',
      'edit eee',
      'drop fff',
      '',
    ].join('\n'),
  );
});
