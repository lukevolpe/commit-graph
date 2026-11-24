import * as vscode from 'vscode';
import { commitWebUrl, getChanges, getDetails, git, stashSelector } from './git';
import { Operation, getOperation, gitNoEditor } from './git';
import { FlowChoice, FlowKind, flowChoices, planFinish, planStart, readFlowConfig, suggestedTag } from './gitflow';
import { GraphController, WIP, errorText } from './controller';
import { revisionUri } from './content';
import * as path from 'node:path';

/** What VS Code passes from `data-vscode-context` on right-click. */
interface Ctx {
  sha?: string;
  refName?: string;
  refKind?: 'branch' | 'remote' | 'tag' | 'head';
  /** `stash@{n}` when the row was drawn; only a label, since indexes shift. */
  stashRef?: string;
}

type Handler = (repo: string, ctx: Ctx, panel: GraphController) => Promise<unknown>;

const short = (sha: string) => sha.slice(0, 7);

async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
  return pick === action;
}

/** Runs a git command with a spinner; reports failures (including conflicts) to the user. */
async function run(panel: GraphController, label: string, args: string[], exec = git): Promise<boolean> {
  try {
    await panel.withBusy(label, () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: label }, () => exec(panel.repo, args)),
    );
    return true;
  } catch (e) {
    const msg = errorText(e);
    if (/conflict/i.test(msg)) {
      const open = 'Open Source Control';
      void vscode.window.showWarningMessage(`${label}: conflicts need resolving.`, open).then((p) => {
        if (p === open) void vscode.commands.executeCommand('workbench.view.scm');
      });
    } else {
      void vscode.window.showErrorMessage(`${label} failed: ${msg}`);
    }
    return false;
  } finally {
    panel.refresh();
  }
}

async function currentBranch(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

const validRefName = async (repo: string, name: string) => {
  try {
    await git(repo, ['check-ref-format', '--branch', name]);
    return null;
  } catch {
    return 'Not a valid name';
  }
};

const handlers: Record<string, Handler> = {
  copySha: async (_r, { sha }) => copy(sha!, 'commit SHA'),

  copyMessage: async (repo, { sha }) => {
    const d = await getDetails(repo, sha!);
    await copy(d.message, 'commit message');
  },

  copyRefName: async (_r, { refName }) => copy(refName!, refName!),

  checkoutCommit: async (repo, { sha }, p) => run(p, `Checkout ${short(sha!)}`, ['checkout', '--detach', sha!]),

  createBranch: async (repo, { sha }, p) => {
    const name = await vscode.window.showInputBox({
      title: `New branch at ${short(sha!)}`,
      prompt: 'The branch is created here and checked out.',
      placeHolder: 'feature/my-branch',
      validateInput: (v) => (v.trim() ? validRefName(repo, v.trim()) : null),
    });
    if (name?.trim()) await run(p, `Create branch ${name.trim()}`, ['switch', '-c', name.trim(), sha!]);
  },

  createTag: async (repo, { sha }, p) => {
    const name = await vscode.window.showInputBox({ title: `New tag at ${short(sha!)}`, placeHolder: 'v1.0.0' });
    if (!name?.trim()) return;
    const message = await vscode.window.showInputBox({
      title: `Tag ${name.trim()}`,
      prompt: 'Message for an annotated tag. Leave empty for a lightweight tag.',
    });
    if (message === undefined) return;
    const args = message ? ['tag', '-a', name.trim(), '-m', message, sha!] : ['tag', name.trim(), sha!];
    await run(p, `Create tag ${name.trim()}`, args);
  },

  cherryPick: async (repo, { sha }, p) => {
    const d = await getDetails(repo, sha!);
    const args = d.parents.length > 1 ? ['cherry-pick', '-m', '1', sha!] : ['cherry-pick', sha!];
    await run(p, `Cherry-pick ${short(sha!)}`, args);
  },

  revert: async (repo, { sha }, p) => {
    const d = await getDetails(repo, sha!);
    const args = d.parents.length > 1 ? ['revert', '--no-edit', '-m', '1', sha!] : ['revert', '--no-edit', sha!];
    await run(p, `Revert ${short(sha!)}`, args);
  },

  merge: async (repo, { sha, refName, refKind }, p) => {
    const target = refKind === 'branch' || refKind === 'remote' ? refName! : sha!;
    const branch = (await currentBranch(repo)) ?? 'HEAD';
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Merge', description: 'Fast-forward when possible', args: [] as string[] },
        { label: 'Merge (no fast-forward)', description: 'Always create a merge commit', args: ['--no-ff'] },
        { label: 'Squash merge', description: 'Stage the changes without committing', args: ['--squash'] },
      ],
      { title: `Merge ${refName ?? short(target)} into ${branch}` },
    );
    if (pick) await run(p, `Merge ${refName ?? short(target)}`, ['merge', ...pick.args, target]);
  },

  rebase: async (repo, { sha, refName }, p) => {
    const target = refName ?? sha!;
    const branch = (await currentBranch(repo)) ?? 'HEAD';
    const ok = await confirm(
      `Rebase ${branch} onto ${refName ?? short(sha!)}?`,
      'Your commits are replayed on top of it, which rewrites their history.',
      'Rebase',
    );
    if (ok) await run(p, `Rebase onto ${refName ?? short(sha!)}`, ['rebase', target]);
  },

  reset: async (repo, { sha }, p) => {
    const branch = (await currentBranch(repo)) ?? 'HEAD';
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Soft', description: 'Keep changes staged', mode: '--soft' },
        { label: 'Mixed', description: 'Keep changes, unstaged', mode: '--mixed' },
        { label: 'Hard', description: 'Discard all changes', mode: '--hard' },
      ],
      { title: `Reset ${branch} to ${short(sha!)}` },
    );
    if (!pick) return;
    if (pick.mode === '--hard') {
      const ok = await confirm(
        `Hard reset ${branch} to ${short(sha!)}?`,
        'Uncommitted changes and commits after this point will be lost.',
        'Reset',
      );
      if (!ok) return;
    }
    await run(p, `Reset to ${short(sha!)}`, ['reset', pick.mode, sha!]);
  },

  compareWorking: async (repo, { sha }) => {
    const files = await getChanges(repo, sha!);
    if (!files.length) return vscode.window.showInformationMessage(`No differences from ${short(sha!)}.`);
    const resources = files.map((f) => {
      const file = vscode.Uri.file(path.join(repo, f.path));
      const left = f.status === 'A' ? revisionUri(repo, f.path, '') : revisionUri(repo, f.oldPath ?? f.path, sha!);
      const right = f.status === 'D' ? revisionUri(repo, f.path, '') : file;
      return [file, left, right];
    });
    await vscode.commands.executeCommand('vscode.changes', `${short(sha!)} ↔ Working Tree`, resources);
  },

  openOnRemote: async (repo, { sha }) => {
    let remote: string;
    try {
      const remotes = (await git(repo, ['remote'])).trim().split('\n').filter(Boolean);
      const name = remotes.includes('origin') ? 'origin' : remotes[0];
      if (!name) throw new Error('No remotes');
      remote = (await git(repo, ['remote', 'get-url', name])).trim();
    } catch {
      return vscode.window.showWarningMessage('This repository has no remote.');
    }
    const url = commitWebUrl(remote, sha!);
    if (!url) return vscode.window.showWarningMessage(`Can't build a web link for ${remote}.`);
    await vscode.env.openExternal(vscode.Uri.parse(url));
  },

  checkoutBranch: async (repo, { refName, refKind }, p) => {
    if (refKind !== 'remote') return run(p, `Switch to ${refName}`, ['switch', refName!]);
    const local = refName!.slice(refName!.indexOf('/') + 1);
    let exists = true;
    try {
      await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${local}`]);
    } catch {
      exists = false;
    }
    return exists
      ? run(p, `Switch to ${local}`, ['switch', local])
      : run(p, `Check out ${refName}`, ['switch', '--track', refName!]);
  },

  renameBranch: async (repo, { refName }, p) => {
    const name = await vscode.window.showInputBox({
      title: `Rename ${refName}`,
      value: refName,
      validateInput: (v) => (v.trim() ? validRefName(repo, v.trim()) : null),
    });
    if (name?.trim() && name.trim() !== refName) await run(p, `Rename ${refName}`, ['branch', '-m', refName!, name.trim()]);
  },

  deleteBranch: async (repo, { refName }, p) => {
    if (refName === (await currentBranch(repo))) {
      return vscode.window.showWarningMessage(`${refName} is checked out. Switch to another branch first.`);
    }
    if (!(await confirm(`Delete branch ${refName}?`, 'Only the local branch is deleted.', 'Delete'))) return;
    try {
      await git(repo, ['branch', '-d', refName!]);
      p.refresh();
    } catch (e) {
      if (!/not fully merged/.test(errorText(e))) return vscode.window.showErrorMessage(errorText(e));
      const force = await confirm(
        `${refName} is not fully merged.`,
        'Its unmerged commits will only be reachable from the reflog.',
        'Delete Anyway',
      );
      if (force) await run(p, `Delete ${refName}`, ['branch', '-D', refName!]);
    }
  },

  pull: async (repo, _ctx, p) => {
    const s = p.sync;
    if (!s?.current || s.current.gone) {
      return vscode.window.showWarningMessage(
        s?.branch ? `${s.branch} has no upstream to pull from.` : 'Check out a branch to pull.',
      );
    }
    const args = ['pull'];
    // Diverged with no pull strategy configured: git refuses, so ask instead.
    if (s.current.ahead && s.current.behind && !(await configured(repo, 'pull.rebase', 'pull.ff'))) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Merge', description: 'Create a merge commit', flag: '--no-rebase' },
          { label: 'Rebase', description: 'Replay your commits on top', flag: '--rebase' },
        ],
        { title: `${s.branch}: ${s.current.ahead} to push, ${s.current.behind} to pull. How should they combine?` },
      );
      if (!pick) return;
      args.push(pick.flag);
    }
    return run(p, `Pull ${s.current.upstream}`, args);
  },

  push: async (repo, _ctx, p) => {
    const s = p.sync;
    if (!s?.branch) return vscode.window.showWarningMessage('Check out a branch to push.');
    if (!s.current || s.current.gone) {
      if (!s.remote) return vscode.window.showWarningMessage('This repository has no remote to publish to.');
      return run(p, `Publish ${s.branch} to ${s.remote}`, ['push', '-u', s.remote, s.branch]);
    }
    if (s.current.behind) {
      const pull = 'Pull';
      const pick = await vscode.window.showWarningMessage(
        `${s.current.upstream} has ${s.current.behind} ${s.current.behind === 1 ? 'commit' : 'commits'} you don't have.`,
        { modal: true, detail: 'Pull them first; a plain push would be rejected.' },
        pull,
      );
      if (pick === pull) await handlers.pull(repo, {}, p);
      return;
    }
    return run(p, `Push to ${s.current.upstream}`, ['push']);
  },

  highlightRef: async (_r, { refName }, p) => p.post({ type: 'highlight', ref: refName }),
  highlightLane: async (_r, { sha }, p) => p.post({ type: 'highlight', sha }),
  clearHighlight: async (_r, _ctx, p) => p.post({ type: 'highlight' }),
  compareWithSelected: async (_r, { sha }, p) => p.post({ type: 'compareWith', sha }),

  applyStash: async (repo, ctx, p) => stashAction(repo, ctx, p, 'apply'),
  popStash: async (repo, ctx, p) => stashAction(repo, ctx, p, 'pop'),
  dropStash: async (repo, ctx, p) => stashAction(repo, ctx, p, 'drop'),

  deleteTag: async (repo, { refName }, p) => {
    if (await confirm(`Delete tag ${refName}?`, 'Only the local tag is deleted.', 'Delete')) {
      await run(p, `Delete tag ${refName}`, ['tag', '-d', refName!]);
    }
  },

  operationContinue: async (repo, _ctx, p) => operationStep(repo, p, 'continue'),
  operationSkip: async (repo, _ctx, p) => operationStep(repo, p, 'skip'),
  operationAbort: async (repo, _ctx, p) => operationStep(repo, p, 'abort'),
  operationBisectGood: async (repo, _ctx, p) => bisectMark(repo, p, 'good'),
  operationBisectBad: async (repo, _ctx, p) => bisectMark(repo, p, 'bad'),
  gitFlow: async (repo, _ctx, p) => gitFlow(repo, p),
};

/** Applies, pops or drops a stash. Its `stash@{n}` is looked up by hash right before running, as indexes shift. */
async function stashAction(repo: string, { sha, stashRef }: Ctx, p: GraphController, op: 'apply' | 'pop' | 'drop') {
  if (op === 'drop') {
    const label = stashRef ?? `stash ${short(sha!)}`;
    if (!(await confirm(`Drop ${label}?`, 'Its changes are deleted for good.', 'Drop'))) return;
  }
  const ref = await stashSelector(repo, sha!);
  if (!ref) {
    p.refresh();
    return vscode.window.showWarningMessage('That stash no longer exists.');
  }
  const verb = { apply: 'Apply', pop: 'Pop', drop: 'Drop' }[op];
  return run(p, `${verb} ${ref}`, ['stash', op, ref]);
}

/** True if any of the git config keys is set. */
async function configured(repo: string, ...keys: string[]): Promise<boolean> {
  for (const k of keys) {
    try {
      if ((await git(repo, ['config', '--get', k])).trim()) return true;
    } catch {
      // exit code 1: not set
    }
  }
  return false;
}

// ---- operation in progress (banner buttons) -------------------------------------

const OP_NAME: Record<Operation['kind'], string> = {
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
  bisect: 'bisect',
};

/** Continue / skip / abort the merge, rebase, cherry-pick or revert in progress (`git <op> --<step>`). */
async function operationStep(repo: string, p: GraphController, step: 'continue' | 'skip' | 'abort') {
  const op = await getOperation(repo);
  p.refreshOperation();
  if (!op) return vscode.window.showInformationMessage('No merge, rebase, cherry-pick or revert in progress.');
  const name = OP_NAME[op.kind];
  if (op.kind === 'bisect') {
    if (step !== 'abort') return vscode.window.showInformationMessage('Mark the checked-out commit Good or Bad.');
    if (!(await confirm('End the bisect?', 'You go back to the branch you started from.', 'End Bisect'))) return;
    return run(p, 'End bisect', ['bisect', 'reset']);
  }
  if (step === 'skip' && op.kind === 'merge') return vscode.window.showWarningMessage("A merge can't be skipped.");
  if (step === 'continue' && op.conflicts.length) {
    const n = op.conflicts.length;
    const open = 'Open Source Control';
    const pick = await vscode.window.showWarningMessage(
      `${n} ${n === 1 ? 'file still has' : 'files still have'} conflicts. Resolve and stage ${n === 1 ? 'it' : 'them'} first.`,
      open,
    );
    if (pick === open) void vscode.commands.executeCommand('workbench.view.scm');
    return;
  }
  if (step === 'abort') {
    const detail =
      op.kind === 'rebase'
        ? `${op.head ?? 'HEAD'} goes back to where it was before the rebase.`
        : 'Changes made by it, including resolved conflicts, are discarded.';
    if (!(await confirm(`Abort the ${name}?`, detail, 'Abort'))) return;
  }
  const verb = { continue: 'Continue', skip: 'Skip', abort: 'Abort' }[step];
  return run(p, `${verb} ${name}`, [op.kind, `--${step}`], gitNoEditor);
}

async function bisectMark(repo: string, p: GraphController, mark: 'good' | 'bad') {
  if ((await getOperation(repo))?.kind !== 'bisect') return vscode.window.showInformationMessage('No bisect in progress.');
  try {
    const out = await p.withBusy(`Bisect ${mark}`, () => git(repo, ['bisect', mark]));
    const found = out.match(/^([0-9a-f]{7,40}) is the first bad commit/m);
    if (found) {
      void vscode.window.showInformationMessage(`First bad commit: ${short(found[1])}. End the bisect when done.`);
      p.post({ type: 'jumpTo', hash: found[1] });
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`Bisect ${mark} failed: ${errorText(e)}`);
  } finally {
    p.refresh();
  }
}

// ---- git flow ------------------------------------------------------------------

const FLOW_TITLE: Record<FlowKind, string> = { feature: 'Feature', release: 'Release', hotfix: 'Hotfix' };

/** Git-flow with plain git: start or finish a feature, release or hotfix branch. */
async function gitFlow(repo: string, p: GraphController) {
  const cfg = await readFlowConfig(repo);
  const current = await currentBranch(repo);
  const describe = (c: FlowChoice) => {
    const base = c.kind === 'hotfix' ? cfg.main : cfg.develop;
    if (c.action === 'start') return `${cfg.prefix[c.kind]}… from ${base}`;
    return c.kind === 'feature' ? `merge into ${cfg.develop}` : `merge into ${cfg.main} and ${cfg.develop}, tag`;
  };
  type Item = vscode.QuickPickItem & { choice: FlowChoice };
  const items: Item[] = flowChoices(cfg, current).map((c) => ({
    label: c.action === 'finish' ? `$(check) Finish ${FLOW_TITLE[c.kind]} ${c.name}` : `$(add) Start ${FLOW_TITLE[c.kind]}`,
    description: describe(c),
    choice: c,
  }));
  const pick = await vscode.window.showQuickPick(items, { title: 'Git Flow' });
  if (!pick) return;
  const { action, kind } = pick.choice;
  const label = FLOW_TITLE[kind];
  let cmds: string[][];
  if (action === 'start') {
    const base = kind === 'hotfix' ? cfg.main : cfg.develop;
    if (!cfg.branches.includes(cfg.main) && !cfg.branches.includes(base)) {
      return vscode.window.showWarningMessage(`No ${base} branch to start from.`);
    }
    const name = await vscode.window.showInputBox({
      title: `Start ${label}`,
      prompt: `Creates ${cfg.prefix[kind]}<name> from ${base} and switches to it.`,
      placeHolder: kind === 'feature' ? 'my-feature' : '1.2.0',
      validateInput: (v) => (v.trim() ? validRefName(repo, cfg.prefix[kind] + v.trim()) : null),
    });
    if (!name?.trim()) return;
    cmds = planStart(cfg, kind, name.trim(), cfg.branches);
  } else {
    const branch = current!;
    if (!cfg.branches.includes(cfg.develop)) return vscode.window.showWarningMessage(`No ${cfg.develop} branch to merge into.`);
    let tag: string | undefined;
    if (kind !== 'feature') {
      tag = await vscode.window.showInputBox({
        title: `Finish ${label} ${pick.choice.name}: tag ${cfg.main}`,
        prompt: 'Annotated tag for the merge on ' + cfg.main + '. Leave empty for no tag.',
        value: suggestedTag(cfg, kind, branch),
      });
      if (tag === undefined) return;
    }
    const del = await vscode.window.showQuickPick(
      [
        { label: `Delete ${branch}`, description: 'After merging', deleteBranch: true },
        { label: `Keep ${branch}`, deleteBranch: false },
      ],
      { title: `Finish ${label} ${pick.choice.name}` },
    );
    if (!del) return;
    cmds = planFinish(cfg, kind, branch, { tag: tag?.trim() || undefined, deleteBranch: del.deleteBranch });
  }
  // Run in order; stop at the first failure (a conflict leaves the merge to the banner).
  for (const args of cmds) {
    if (!(await run(p, `${action === 'start' ? 'Start' : 'Finish'} ${label}: git ${args.join(' ')}`, args, gitNoEditor))) return;
  }
  void vscode.window.setStatusBarMessage(`$(check) ${action === 'start' ? 'Started' : 'Finished'} ${label.toLowerCase()}`, 3000);
}

async function copy(text: string, label: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  void vscode.window.setStatusBarMessage(`$(check) Copied ${label}`, 2000);
}

export function registerActions(context: vscode.ExtensionContext): void {
  for (const [name, fn] of Object.entries(handlers)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`commitGraph.${name}`, async (ctx: Ctx = {}) => {
        const panel = GraphController.active;
        if (!panel || ctx.sha === WIP) return;
        try {
          await fn(panel.repo, ctx, panel);
        } catch (e) {
          void vscode.window.showErrorMessage(errorText(e));
        }
      }),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('commitGraph.fetch', async () => {
      const panel = GraphController.active;
      if (!panel) return;
      try {
        await panel.withBusy('Fetching', () =>
          vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Fetching all remotes…' },
            () => git(panel.repo, ['fetch', '--all', '--prune']),
          ),
        );
      } catch (e) {
        void vscode.window.showErrorMessage(`Fetch failed: ${errorText(e)}`);
      } finally {
        panel.refresh();
      }
    }),
  );
}
