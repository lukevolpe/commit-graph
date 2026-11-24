import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropChoices } from '../src/drop';

const pick = (cs: ReturnType<typeof dropChoices>) => cs.map((c) => [c.label, c.steps]);

test('label on the current branch: merge, rebase, fast-forward without switching', () => {
  const cs = dropChoices({ src: 'feature', srcKind: 'branch', onto: 'main' }, 'main', true);
  assert.deepEqual(pick(cs), [
    ['Merge feature into main', [['merge', 'feature']]],
    ['Rebase main onto feature', [['rebase', 'feature']]],
    ['Fast-forward main to feature', [['merge', '--ff-only', 'feature']]],
  ]);
  assert.ok(cs.every((c) => !/switch/i.test(c.detail ?? '')));
});

test('label on another branch: switch first, said in the detail', () => {
  const cs = dropChoices({ src: 'feature', srcKind: 'branch', onto: 'main' }, 'dev', false);
  assert.deepEqual(pick(cs), [
    ['Merge feature into main', [['switch', 'main'], ['merge', 'feature']]],
    ['Rebase main onto feature', [['switch', 'main'], ['rebase', 'feature']]],
  ]);
  assert.ok(cs.every((c) => /Switches to main first/.test(c.detail ?? '')));
});

test('fast-forward of a branch that is not checked out moves the ref without switching', () => {
  const cs = dropChoices({ src: 'origin/main', srcKind: 'remote', onto: 'main' }, 'dev', true);
  assert.deepEqual(cs[2].steps, [['fetch', '.', 'refs/remotes/origin/main:refs/heads/main']]);
  assert.ok(!/Switches/.test(cs[2].detail ?? ''));
});

test('branch on a commit: rebase onto it, or merge it in', () => {
  const sha = 'abcdef1234567890';
  assert.deepEqual(pick(dropChoices({ src: 'feature', srcKind: 'branch', sha }, 'feature', false)), [
    ['Rebase feature onto abcdef1', [['rebase', sha]]],
    ['Merge abcdef1 into feature', [['merge', sha]]],
  ]);
  const other = dropChoices({ src: 'feature', srcKind: 'branch', sha }, 'main', false);
  assert.deepEqual(other[0].steps, [['switch', 'feature'], ['rebase', sha]]);
  assert.match(other[0].detail ?? '', /Switches to feature first/);
});

test('remote branch on a commit: nothing to offer', () => {
  assert.deepEqual(dropChoices({ src: 'origin/x', srcKind: 'remote', sha: 'abc1234' }, 'main', false), []);
});
