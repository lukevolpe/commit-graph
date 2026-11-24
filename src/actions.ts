import * as vscode from 'vscode';
import { commitWebUrl, getChanges, getDetails, git, stashSelector } from './git';
import { GraphController, WIP, errorText } from './controller';
import { revisionUri } from './content';
import * as path from 'node:path';
import { readdirSync } from 'node:fs';
import { Worktree, defaultWorktreePath, getWorktrees, otherWorktree, samePath } from './worktrees';
import { pickRepo } from './repos';

/** What VS Code passes from `data-vscode-context` on right-click. */
interface Ctx {
  sha?: string;
  refName?: string;
  refKind?: 'branch' | 'remote' | 'tag' | 'head';
  /** `stash@{n}` when the row was drawn; only a label, since indexes shift. */
  stashRef?: string;
  /** Worktree folder: on a branch label checked out elsewhere, or a detached worktree's label. */
  worktreePath?: string;
}

type Handler = (repo: string, ctx: Ctx, panel: GraphController) => Promise<unknown>;

const short = (sha: string) => sha.slice(0, 7);

async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
  return pick === action;
}

/** Runs a git command with a spinner; reports failures (including conflicts) to the user. */
async function run(panel: GraphController, label: string, args: string[]): Promise<boolean> {
  try {
    await panel.withBusy(label, () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: label }, () => git(panel.repo, args)),
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
    const branch = refKind === 'remote' ? refName!.slice(refName!.indexOf('/') + 1) : refName!;
    // git refuses to check out a branch another worktree has: offer that worktree instead.
    if (await offerOtherWorktree(repo, branch)) return;
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

  createWorktree: async (repo, ctx, p) => createWorktree(repo, ctx, p),
  openWorktree: async (_r, { worktreePath }) => openWorktree(worktreePath!, 'window'),
  removeWorktree: async (repo, { worktreePath }) => removeWorktree(repo, worktreePath!),

  deleteTag: async (repo, { refName }, p) => {
    if (await confirm(`Delete tag ${refName}?`, 'Only the local tag is deleted.', 'Delete')) {
      await run(p, `Delete tag ${refName}`, ['tag', '-d', refName!]);
    }
  },
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

// ---- worktrees -------------------------------------------------------------------

/** If another worktree has `branch` checked out, says so and offers to open it. True when it does. */
async function offerOtherWorktree(repo: string, branch: string): Promise<boolean> {
  const wt = otherWorktree(await getWorktrees(repo).catch(() => []), branch, repo);
  if (!wt) return false;
  const open = 'Open Worktree';
  const add = 'Add to Workspace';
  const pick = await vscode.window.showInformationMessage(`${branch} is checked out in ${wt.path}.`, open, add);
  if (pick === open) await openWorktree(wt.path, 'window');
  else if (pick === add) await openWorktree(wt.path, 'workspace');
  return true;
}

async function openWorktree(folder: string, where: 'window' | 'workspace'): Promise<void> {
  const uri = vscode.Uri.file(folder);
  if (where === 'window') {
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  } else if (!vscode.workspace.workspaceFolders?.some((f) => samePath(f.uri.fsPath, folder))) {
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, null, { uri });
  }
}

/** After a worktree is made: open it in a new window or add it to the workspace. */
async function offerOpenWorktree(folder: string): Promise<void> {
  const open = 'Open in New Window';
  const add = 'Add to Workspace';
  const pick = await vscode.window.showInformationMessage(`Worktree created at ${folder}.`, open, add);
  if (pick === open) await openWorktree(folder, 'window');
  else if (pick === add) await openWorktree(folder, 'workspace');
}

/** New worktree for a branch label. A remote branch gets a local tracking branch unless one exists. */
async function createWorktree(repo: string, { refName, refKind }: Ctx, p: GraphController): Promise<void> {
  let branch = refName!;
  let args: string[] | undefined;
  if (refKind === 'remote') {
    branch = refName!.slice(refName!.indexOf('/') + 1);
    try {
      await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
    } catch {
      args = ['--track', '-b', branch]; // new local branch from the remote one
    }
  }
  if (await offerOtherWorktree(repo, branch)) return;
  const suggested = defaultWorktreePath(repo, branch);
  const input = await vscode.window.showInputBox({
    title: `New worktree for ${branch}`,
    prompt: 'Folder for the worktree. It must not exist yet, or be empty.',
    value: suggested,
    valueSelection: [suggested.length - path.basename(suggested).length, suggested.length],
    validateInput: (v) => {
      if (!v.trim()) return 'Enter a folder';
      try {
        if (readdirSync(path.resolve(repo, v.trim())).length) return 'That folder exists and is not empty';
      } catch {
        // doesn't exist: fine
      }
      return null;
    },
  });
  if (!input?.trim()) return;
  const folder = path.resolve(repo, input.trim());
  const ok = args
    ? await run(p, `Create worktree for ${refName}`, ['worktree', 'add', ...args, folder, refName!])
    : await run(p, `Create worktree for ${branch}`, ['worktree', 'add', folder, branch]);
  if (ok) await offerOpenWorktree(folder);
}

/** Removes a worktree after confirming; a dirty one needs a second, explicit confirm to force. */
async function removeWorktree(repo: string, folder: string): Promise<void> {
  if (samePath(folder, repo)) {
    void vscode.window.showWarningMessage('This is the worktree the graph is showing. Open another one to remove it.');
    return;
  }
  const name = path.basename(folder);
  if (!(await confirm(`Remove worktree ${name}?`, `${folder} is deleted. Its branch is kept.`, 'Remove'))) return;
  const attempt = async (force: boolean) => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Remove worktree ${name}` }, () =>
      git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), folder]),
    );
  };
  try {
    try {
      await attempt(false);
    } catch (e) {
      if (!/modified or untracked/i.test(errorText(e))) throw e;
      const force = await confirm(
        `${name} has uncommitted changes.`,
        'Removing it anyway deletes those changes for good.',
        'Remove Anyway',
      );
      if (force) await attempt(true);
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`Remove worktree failed: ${errorText(e)}`);
  } finally {
    GraphController.forRepo(repo)?.refresh();
  }
}

/** "Commit Graph: Worktrees…": pick a worktree, then open, add, or remove it; or prune stale ones. */
async function worktreesCommand(): Promise<void> {
  const repo = GraphController.active?.repo ?? (await pickRepo());
  if (!repo) return;
  const list = await getWorktrees(repo);
  type Item = vscode.QuickPickItem & { wt?: Worktree; prune?: boolean };
  const items: Item[] = list.map((w) => {
    const current = samePath(w.path, repo);
    const flags = [current && 'current', w.locked && 'locked', w.prunable && 'missing'].filter(Boolean).join(', ');
    return {
      label: `$(${current ? 'check' : 'worktree'}) ${path.basename(w.path)}`,
      description: (w.branch ?? `detached at ${short(w.head)}`) + (flags ? `  (${flags})` : ''),
      detail: w.path,
      wt: w,
    };
  });
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(trash) Prune Stale Worktrees', description: 'Forget worktrees whose folder is gone', prune: true },
  );
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Worktrees', matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;
  if (pick.prune) {
    const out = (await git(repo, ['worktree', 'prune', '-v'])).trim();
    GraphController.forRepo(repo)?.refresh();
    void vscode.window.showInformationMessage(out ? `Pruned: ${out}` : 'No stale worktrees to prune.');
    return;
  }
  const wt = pick.wt!;
  const isMain = wt === list[0];
  const acts = [
    { label: '$(empty-window) Open in New Window', act: 'window' },
    { label: '$(add) Add to Workspace', act: 'workspace' },
    ...(isMain || samePath(wt.path, repo) ? [] : [{ label: '$(trash) Remove…', act: 'remove' }]),
  ];
  const act = await vscode.window.showQuickPick(acts, { title: wt.path });
  if (act?.act === 'remove') await removeWorktree(repo, wt.path);
  else if (act) await openWorktree(wt.path, act.act as 'window' | 'workspace');
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
    vscode.commands.registerCommand('commitGraph.worktrees', () =>
      worktreesCommand().catch((e) => vscode.window.showErrorMessage(errorText(e))),
    ),
  );

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
