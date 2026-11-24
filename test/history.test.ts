import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBlameCommit, getLineHistory, getLog, git, parseBlameCommit } from '../src/git';
import { GraphLayout } from '../src/lanes';

let dir: string;
const g = (...args: string[]) => git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
const subjects = (cs: { subject: string }[]) => cs.map((c) => c.subject);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'commit-graph-history-'));
  await g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\n');
  writeFileSync(join(dir, 'o.txt'), 'x\n');
  await g('add', '.');
  await g('commit', '-q', '-m', 'root');
  appendFileSync(join(dir, 'o.txt'), 'other\n');
  await g('commit', '-q', '-am', 'other only');
  await g('checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 'f.txt'), 'a\nB side\nc\n');
  await g('commit', '-q', '-am', 'side edits f');
  appendFileSync(join(dir, 'o.txt'), 'side other\n');
  await g('commit', '-q', '-am', 'side other');
  await g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\nd main\n');
  await g('commit', '-q', '-am', 'main edits f');
  await g('merge', '-q', '--no-ff', 'side', '-m', 'merge side');
  appendFileSync(join(dir, 'o.txt'), 'late\n');
  await g('commit', '-q', '-am', 'late other');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('file history: only commits touching the file, parents rewritten so lanes connect', async () => {
  const log = await getLog(dir, 'all', 0, 100, 'f.txt');
  assert.deepEqual(subjects(log), ['merge side', 'side edits f', 'main edits f', 'root']);
  const hashes = new Set(log.map((c) => c.hash));
  // Every parent is a shown commit: no dangling lanes to commits that aren't listed.
  for (const c of log) for (const p of c.parents) assert.ok(hashes.has(p), `${c.subject} parent ${p} not shown`);
  assert.equal(log[0].parents.length, 2);
  const rows = new GraphLayout().add(log);
  assert.deepEqual(rows.map((r) => r.col), [0, 1, 0, 0]);
  // Root has no outgoing line; nothing is left open below it.
  assert.ok(!rows[3].lines.some((l) => l.kind === 'out'));

  // Paging works within the file history.
  assert.deepEqual(subjects(await getLog(dir, 'all', 2, 100, 'f.txt')), ['main edits f', 'root']);
  // Unknown path: empty, not an error.
  assert.deepEqual(await getLog(dir, 'all', 0, 100, 'nope.txt'), []);
});

test('line history: commits that changed the range, newest first', async () => {
  const subj = async (hashes: string[]) => {
    const all = await getLog(dir, 'all', 0, 100);
    return hashes.map((h) => all.find((c) => c.hash === h)?.subject);
  };
  assert.deepEqual(await subj(await getLineHistory(dir, 'f.txt', 2, 2)), ['side edits f', 'root']);
  assert.deepEqual(await subj(await getLineHistory(dir, 'f.txt', 4, 4)), ['main edits f']);
});

test('blame: commit that last changed a line; null for uncommitted lines', async () => {
  const all = await getLog(dir, 'all', 0, 100);
  const bySubject = (s: string) => all.find((c) => c.subject === s)!.hash;
  assert.equal(await getBlameCommit(dir, 'f.txt', 2), bySubject('side edits f'));
  assert.equal(await getBlameCommit(dir, 'f.txt', 1), bySubject('root'));
  appendFileSync(join(dir, 'f.txt'), 'uncommitted\n');
  try {
    assert.equal(await getBlameCommit(dir, 'f.txt', 5), null);
  } finally {
    await g('checkout', '--', 'f.txt');
  }
  // Untracked file: null, not a throw.
  writeFileSync(join(dir, 'new.txt'), 'n\n');
  try {
    assert.equal(await getBlameCommit(dir, 'new.txt', 1), null);
  } finally {
    rmSync(join(dir, 'new.txt'));
  }
});

test('parseBlameCommit reads the porcelain header', () => {
  const h = 'a'.repeat(40);
  assert.equal(parseBlameCommit(`${h} 3 3 1\nauthor T\nauthor-mail <t@t>\n\tline\n`), h);
  assert.equal(parseBlameCommit(`${'0'.repeat(40)} 5 5 1\nauthor Not Committed Yet\n\tx\n`), null);
  assert.equal(parseBlameCommit(''), null);
});
