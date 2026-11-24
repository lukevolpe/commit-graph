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

test('a first parent is always reached on its child\'s lane (lane highlight walks this)', () => {
  // Two side branches; B2's first parent M1 is also waited for by M2's lane.
  const commits = [c('M2', 'M1', 'B2'), c('B2', 'M1'), c('M1', 'A', 'B1'), c('B1', 'A'), c('A')];
  const rows = new GraphLayout().add(commits);
  const at = new Map(commits.map((x, i) => [x.hash, i]));
  commits.forEach((x, i) => {
    const p = x.parents[0];
    if (!p) return;
    const lane = rows[i].col;
    assert.ok(rows[i].lines.some((l) => l.kind === 'out' && l.lane === lane), `${x.hash} leaves on lane ${lane}`);
    for (let k = i + 1; k < at.get(p)!; k++) {
      assert.ok(rows[k].lines.some((l) => l.kind === 'pass' && l.lane === lane), `lane ${lane} passes row ${k}`);
    }
    assert.ok(rows[at.get(p)!].lines.some((l) => l.kind === 'in' && l.lane === lane), `${p} entered from lane ${lane}`);
  });
});

const side = (hash: string, parent: string): LayoutCommit => ({ hash, parents: [parent], side: true });

test('stash on a branch tip gets a side lane; the tip keeps lane 0', () => {
  const rows = new GraphLayout().add([side('S', 'H'), c('H', 'A'), c('A')]);
  assert.deepEqual(rows.map((r) => r.col), [1, 0, 0]);
  assert.deepEqual(rows[0].lines, [{ kind: 'out', lane: 1, color: 0 }]);
  assert.deepEqual(rows[1].lines.filter((l) => l.kind === 'in').map((l) => l.lane), [1]);
  // Side lane is closed after joining.
  assert.deepEqual(rows[2].lines.map((l) => l.kind), ['in']);
});

test('stash under the uncommitted row, and two stashes on one base', () => {
  assert.deepEqual(cols([c('WIP', 'H'), side('S', 'H'), c('H', 'A'), c('A')]), [0, 1, 0, 0]);
  assert.deepEqual(cols([side('S0', 'H'), side('S1', 'H'), c('H', 'A'), c('A')]), [1, 2, 0, 0]);
});

test('stash on an older commit joins it without pulling its line sideways', () => {
  // Lane 1 waits for B (side branch F); the stash on B gets lane 2 and B stays in lane 1.
  const rows = new GraphLayout().add([c('M', 'A', 'F'), c('F', 'B'), side('S', 'B'), c('B', 'A'), c('A')]);
  assert.deepEqual(rows.map((r) => r.col), [0, 1, 2, 1, 0]);
});
