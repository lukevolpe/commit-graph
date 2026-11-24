import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git';
import { flowChoices, planFinish, planStart, readFlowConfig, resolveFlowConfig, suggestedTag } from '../src/gitflow';

const defaults = resolveFlowConfig({}, ['main', 'develop']);

test('config: defaults, main/master fallback, git config overrides', () => {
  assert.deepEqual(defaults, {
    develop: 'develop',
    main: 'main',
    prefix: { feature: 'feature/', release: 'release/', hotfix: 'hotfix/' },
    versionTag: '',
  });
  assert.equal(resolveFlowConfig({}, ['master', 'develop']).main, 'master');
  assert.equal(resolveFlowConfig({}, []).main, 'main');
  const custom = resolveFlowConfig(
    {
      'gitflow.branch.master': 'production',
      'gitflow.branch.develop': 'dev',
      'gitflow.prefix.feature': 'feat-',
      'gitflow.prefix.versiontag': 'v',
    },
    ['main'],
  );
  assert.equal(custom.main, 'production');
  assert.equal(custom.develop, 'dev');
  assert.equal(custom.prefix.feature, 'feat-');
  assert.equal(custom.prefix.release, 'release/');
  assert.equal(custom.versionTag, 'v');
});

test('choices: Start always; Finish only for the branch type you are on', () => {
  const ids = (b: string | null) => flowChoices(defaults, b).map((c) => `${c.action} ${c.kind}`);
  assert.deepEqual(ids('main'), ['start feature', 'start release', 'start hotfix']);
  assert.deepEqual(ids('feature/login'), ['finish feature', 'start feature', 'start release', 'start hotfix']);
  assert.deepEqual(ids('release/1.2.0'), ['finish release', 'start feature', 'start release', 'start hotfix']);
  assert.equal(flowChoices(defaults, 'hotfix/1.2.1')[0].name, '1.2.1');
  assert.deepEqual(ids(null), ['start feature', 'start release', 'start hotfix']);
});

test('start: feature and release from develop, hotfix from main', () => {
  assert.deepEqual(planStart(defaults, 'feature', 'login', ['main', 'develop']), [
    ['switch', '-c', 'feature/login', 'develop'],
  ]);
  assert.deepEqual(planStart(defaults, 'release', '1.2.0', ['main', 'develop']), [
    ['switch', '-c', 'release/1.2.0', 'develop'],
  ]);
  assert.deepEqual(planStart(defaults, 'hotfix', '1.2.1', ['main', 'develop']), [
    ['switch', '-c', 'hotfix/1.2.1', 'main'],
  ]);
  // No develop yet: create it from main first.
  assert.deepEqual(planStart(defaults, 'feature', 'login', ['main']), [
    ['branch', 'develop', 'main'],
    ['switch', '-c', 'feature/login', 'develop'],
  ]);
});

test('finish feature: merge --no-ff into develop, optionally delete', () => {
  assert.deepEqual(planFinish(defaults, 'feature', 'feature/login', { deleteBranch: true }), [
    ['switch', 'develop'],
    ['merge', '--no-ff', '--no-edit', 'feature/login'],
    ['branch', '-d', 'feature/login'],
  ]);
  assert.deepEqual(planFinish(defaults, 'feature', 'feature/login', { deleteBranch: false }), [
    ['switch', 'develop'],
    ['merge', '--no-ff', '--no-edit', 'feature/login'],
  ]);
});

test('finish release/hotfix: into main, tag, into develop, delete', () => {
  assert.deepEqual(planFinish(defaults, 'release', 'release/1.2.0', { tag: '1.2.0', deleteBranch: true }), [
    ['switch', 'main'],
    ['merge', '--no-ff', '--no-edit', 'release/1.2.0'],
    ['tag', '-a', '1.2.0', '-m', 'Release 1.2.0'],
    ['switch', 'develop'],
    ['merge', '--no-ff', '--no-edit', '1.2.0'],
    ['branch', '-d', 'release/1.2.0'],
  ]);
  // No tag, keep branch.
  assert.deepEqual(planFinish(defaults, 'hotfix', 'hotfix/1.2.1', { deleteBranch: false }), [
    ['switch', 'main'],
    ['merge', '--no-ff', '--no-edit', 'hotfix/1.2.1'],
    ['switch', 'develop'],
    ['merge', '--no-ff', '--no-edit', 'hotfix/1.2.1'],
  ]);
});

test('suggested tag: branch name minus prefix, plus version tag prefix', () => {
  assert.equal(suggestedTag(defaults, 'release', 'release/1.2.0'), '1.2.0');
  assert.equal(suggestedTag({ ...defaults, versionTag: 'v' }, 'hotfix', 'hotfix/1.2.1'), 'v1.2.1');
});

test('readFlowConfig reads git config and branches; a full release runs on a real repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'commit-graph-flow-'));
  const g = (...args: string[]) => git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
  try {
    await g('init', '-q', '-b', 'master');
    writeFileSync(join(dir, 'a.txt'), '1\n');
    await g('add', '.');
    await g('commit', '-q', '-m', 'root');
    await g('config', 'gitflow.prefix.versiontag', 'v');
    const cfg = await readFlowConfig(dir);
    assert.equal(cfg.main, 'master');
    assert.equal(cfg.versionTag, 'v');
    assert.deepEqual(cfg.branches.sort(), ['master']);

    const run = async (cmds: string[][]) => {
      for (const c of cmds) await g(...c);
    };
    await run(planStart(cfg, 'release', '2.0', cfg.branches));
    await g('commit', '-q', '--allow-empty', '-m', 'bump');
    await run(planFinish(cfg, 'release', 'release/2.0', { tag: suggestedTag(cfg, 'release', 'release/2.0'), deleteBranch: true }));
    assert.equal((await g('branch', '--show-current')).trim(), 'develop');
    assert.equal((await g('tag')).trim(), 'v2.0');
    assert.equal((await g('branch', '--list', 'release/*')).trim(), '');
    // The tag is on master, and develop contains it.
    assert.equal((await g('rev-parse', 'v2.0^{commit}')).trim(), (await g('rev-parse', 'master')).trim());
    await g('merge-base', '--is-ancestor', 'v2.0', 'develop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
