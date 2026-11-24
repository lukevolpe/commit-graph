import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git';
import {
  defaultBranch,
  getRemotes,
  hasPrTemplate,
  isNonFastForward,
  prCommits,
  prDraft,
  pruneRemote,
  pullRequestUrl,
  splitRemoteRef,
} from '../src/remotes';

test('pullRequestUrl builds GitHub, GitLab and Bitbucket compare pages', () => {
  assert.equal(
    pullRequestUrl('git@github.com:o/r.git', 'feat/a#1', 'main'),
    'https://github.com/o/r/compare/main...feat/a%231?expand=1',
  );
  assert.equal(
    pullRequestUrl('https://gitlab.example.com/g/sub/r.git', 'feat/a', 'develop'),
    'https://gitlab.example.com/g/sub/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fa&merge_request%5Btarget_branch%5D=develop',
  );
  assert.equal(
    pullRequestUrl('https://me@bitbucket.org/o/r.git', 'fix me', 'master'),
    'https://bitbucket.org/o/r/pull-requests/new?source=fix%20me&dest=master',
  );
  assert.equal(pullRequestUrl('https://git.example.com/o/r.git', 'a', 'main'), undefined);
  assert.equal(pullRequestUrl('/srv/repos/r.git', 'a', 'main'), undefined);
});

test('pullRequestUrl fills in title and description where the host supports it', () => {
  const d = { title: 'Add search & more', body: '- one\n- two' };
  assert.equal(
    pullRequestUrl('git@github.com:o/r.git', 'feat/a', 'main', d),
    'https://github.com/o/r/compare/main...feat/a?expand=1&title=Add%20search%20%26%20more&body=-%20one%0A-%20two',
  );
  assert.equal(
    pullRequestUrl('https://gitlab.com/g/r.git', 'feat/a', 'main', d),
    'https://gitlab.com/g/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fa&merge_request%5Btarget_branch%5D=main' +
      '&merge_request%5Btitle%5D=Add%20search%20%26%20more&merge_request%5Bdescription%5D=-%20one%0A-%20two',
  );
  // No body: only the title is sent, so the host's template stays.
  assert.equal(
    pullRequestUrl('git@github.com:o/r.git', 'a', 'main', { title: 'T' }),
    'https://github.com/o/r/compare/main...a?expand=1&title=T',
  );
  // Bitbucket has no prefill: the plain page.
  assert.equal(
    pullRequestUrl('https://bitbucket.org/o/r.git', 'a', 'main', d),
    'https://bitbucket.org/o/r/pull-requests/new?source=a&dest=main',
  );
});

test('prDraft: one commit gives its subject and body', () => {
  assert.deepEqual(prDraft('feat/x', [{ subject: 'Fix login timeout', body: 'Raise it to 30s.\n' }]), {
    title: 'Fix login timeout',
    body: 'Raise it to 30s.',
  });
  assert.deepEqual(prDraft('feat/x', [{ subject: 'Fix', body: '' }]), { title: 'Fix', body: undefined });
});

test('prDraft: several commits give a title from the branch and a commit list', () => {
  const commits = [
    { subject: 'Add search', body: 'x' },
    { subject: 'Search takes query', body: '' },
  ];
  assert.deepEqual(prDraft('feature/add-search_box', commits), {
    title: 'Add search box',
    body: '- Add search\n- Search takes query',
  });
  const many = Array.from({ length: 40 }, (_, i) => ({ subject: `c${i}`, body: '' }));
  const body = prDraft('b', many).body!;
  assert.equal(body.split('\n').length, 31);
  assert.ok(body.endsWith('- …and 10 more'));
  assert.deepEqual(prDraft('b', []), { title: 'B' });
});

test('prCommits lists commits on the branch but not the base, oldest first; hasPrTemplate looks in the base', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-pr-'));
  try {
    const g = (...a: string[]) => git(dir, a);
    await g('init', '-q', '-b', 'main');
    await g('config', 'user.email', 't@t');
    await g('config', 'user.name', 't');
    await g('commit', '-q', '--allow-empty', '-m', 'base');
    assert.equal(await hasPrTemplate(dir, 'main'), false);
    await g('switch', '-q', '-c', 'feat');
    await g('commit', '-q', '--allow-empty', '-m', 'first', '-m', 'details');
    await g('commit', '-q', '--allow-empty', '-m', 'second');
    assert.deepEqual(await prCommits(dir, 'main', 'feat'), [
      { subject: 'first', body: 'details' },
      { subject: 'second', body: '' },
    ]);
    await g('switch', '-q', 'main');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, '.github'));
    writeFileSync(join(dir, '.github', 'PULL_REQUEST_TEMPLATE.md'), '## Why\n');
    await g('add', '.');
    await g('commit', '-q', '-m', 'template');
    assert.equal(await hasPrTemplate(dir, 'main'), true);
    assert.equal(await hasPrTemplate(dir, 'feat'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('splitRemoteRef finds the remote by longest name prefix', () => {
  const remotes = ['origin', 'up', 'up/stream'];
  assert.deepEqual(splitRemoteRef('origin/feat/x', remotes), { remote: 'origin', branch: 'feat/x' });
  assert.deepEqual(splitRemoteRef('up/stream/main', remotes), { remote: 'up/stream', branch: 'main' });
  assert.deepEqual(splitRemoteRef('up/main', remotes), { remote: 'up', branch: 'main' });
  assert.equal(splitRemoteRef('other/main', remotes), null);
  assert.equal(splitRemoteRef('origin', remotes), null);
});

test('isNonFastForward spots pushes rejected because the remote moved on', () => {
  assert.equal(isNonFastForward(' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs'), true);
  assert.equal(isNonFastForward(' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs'), true);
  assert.equal(isNonFastForward('fatal: Could not read from remote repository.'), false);
});

// ---- against real repos -----------------------------------------------------------

test('remotes: list, default branch, prune, rejected push', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commit-graph-remotes-'));
  const remote = join(root, 'remote.git');
  const other = join(root, 'other.git');
  const a = join(root, 'a');
  const b = join(root, 'b');
  const ga = (...args: string[]) => git(a, ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
  const gb = (...args: string[]) => git(b, ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
  try {
    await git(root, ['init', '-q', '--bare', '-b', 'trunk', remote]);
    await git(root, ['init', '-q', '--bare', '-b', 'master', other]);
    await git(root, ['clone', '-q', remote, b]);
    await gb('commit', '-q', '--allow-empty', '-m', 'one');
    await gb('push', '-q', 'origin', 'trunk', 'trunk:doomed');
    await git(root, ['clone', '-q', remote, a]);

    // Clone sets origin/HEAD.
    assert.equal(await defaultBranch(a, 'origin'), 'trunk');

    await ga('remote', 'add', 'up', other);
    assert.deepEqual(await getRemotes(a), [
      { name: 'origin', url: remote },
      { name: 'up', url: other },
    ]);
    // No up/HEAD: falls back to main, then master, else null.
    assert.equal(await defaultBranch(a, 'up'), null);
    await ga('push', '-q', 'up', 'trunk:master');
    assert.equal(await defaultBranch(a, 'up'), 'master');
    await ga('push', '-q', 'up', 'trunk:main');
    assert.equal(await defaultBranch(a, 'up'), 'main');
    await ga('remote', 'remove', 'up');
    assert.deepEqual((await getRemotes(a)).map((r) => r.name), ['origin']);

    // Deleted on the remote: prune drops the stale tracking branch and names it.
    await gb('push', '-q', 'origin', '--delete', 'doomed');
    assert.deepEqual(await pruneRemote(a, 'origin'), ['origin/doomed']);
    assert.deepEqual(await pruneRemote(a, 'origin'), []);

    // Diverged push is rejected as non-fast-forward.
    await gb('commit', '-q', '--allow-empty', '-m', 'theirs');
    await gb('push', '-q');
    await ga('commit', '-q', '--allow-empty', '-m', 'mine');
    await ga('fetch', '-q');
    const err = await ga('push').then(
      () => '',
      (e: Error) => e.message,
    );
    assert.equal(isNonFastForward(err), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
