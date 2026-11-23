import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphLayout, LayoutCommit } from '../src/lanes';

const c = (hash: string, ...parents: string[]): LayoutCommit => ({ hash, parents });
const cols = (commits: LayoutCommit[]) => new GraphLayout().add(commits).map((r) => r.col);

test('linear history stays in lane 0', () => {
  const rows = new GraphLayout().add([c('C', 'B'), c('B', 'A'), c('A')]);
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 0]);
  assert.deepEqual(rows[0].lines.map((l) => l.kind), ['out']);
  assert.deepEqual(rows[1].lines.map((l) => l.kind), ['in', 'out']);
  assert.deepEqual(rows[2].lines.map((l) => l.kind), ['in']);
});

test('merge opens a side lane that rejoins at the fork point', () => {
  // A ← B ← M, A ← F ← M
  const rows = new GraphLayout().add([c('M', 'B', 'F'), c('F', 'A'), c('B', 'A'), c('A')]);
  assert.deepEqual(rows.map((r) => r.col), [0, 1, 0, 0]);
  assert.deepEqual(rows[0].lines, [
    { kind: 'out', lane: 0, color: 0 },
    { kind: 'out', lane: 1, color: 1 },
  ]);
  // F row: lane 0 passes through
  assert.ok(rows[1].lines.some((l) => l.kind === 'pass' && l.lane === 0));
  // A row: both lanes come in
  assert.deepEqual(
    rows[3].lines.filter((l) => l.kind === 'in').map((l) => l.lane),
    [0, 1],
  );
});

test('two unmerged branch tips get separate lanes', () => {
  assert.deepEqual(cols([c('X', 'A'), c('Y', 'A'), c('A')]), [0, 1, 0]);
});

test('freed lanes are reused', () => {
  // side branch S ends at A; later tip T should reuse lane 1
  const rows = cols([c('M', 'B', 'S'), c('S', 'B'), c('B', 'A'), c('T', 'A'), c('A')]);
  assert.deepEqual(rows, [0, 1, 0, 1, 0]);
});

test('octopus merge opens one lane per extra parent', () => {
  const rows = new GraphLayout().add([c('M', 'A', 'B', 'C'), c('C', 'R'), c('B', 'R'), c('A', 'R'), c('R')]);
  assert.deepEqual(rows.map((r) => r.col), [0, 2, 1, 0, 0]);
  assert.equal(rows[0].lines.filter((l) => l.kind === 'out').length, 3);
});

test('state carries across pages', () => {
  const layout = new GraphLayout();
  const page1 = layout.add([c('M', 'B', 'F'), c('F', 'A')]);
  const page2 = layout.add([c('B', 'A'), c('A')]);
  assert.deepEqual([...page1, ...page2].map((r) => r.col), [0, 1, 0, 0]);
});

test('root commit ends its lane', () => {
  const rows = new GraphLayout().add([c('A')]);
  assert.deepEqual(rows[0], { col: 0, color: 0, lines: [] });
});
