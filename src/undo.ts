import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { getHead, git } from './git';

export type UndoKind = 'commit' | 'amend' | 'merge' | 'checkout' | 'reset' | 'rebase' | 'pull' | 'cherry-pick' | 'revert';

/** What the last HEAD reflog entry did, as far as undo cares. */
export interface ReflogAction {
  kind: UndoKind;
  /** Human wording, e.g. `commit “fix login”`. */
  label: string;
  /** checkout: where HEAD was and went. */
  from?: string;
  to?: string;
  /** rebase / pull --rebase: the branch that was rewritten. Its own reflog holds the pre-rebase tip. */
  branch?: string;
}

const q = (s: string) => `“${s}”`;

/**
 * Classifies a HEAD reflog subject (`%gs`). null for anything not safely undoable:
 * the first commit, steps inside an unfinished rebase, clones, unknown actions.
 */
export function classifyReflog(subject: string): ReflogAction | null {
  let m: RegExpExecArray | null;
  if ((m = /^commit: (.*)$/s.exec(subject))) return { kind: 'commit', label: `commit ${q(m[1])}` };
  if ((m = /^commit \(amend\): (.*)$/s.exec(subject))) return { kind: 'amend', label: `amend of ${q(m[1])}` };
  if ((m = /^commit \(merge\): (.*)$/s.exec(subject))) return { kind: 'merge', label: `merge commit ${q(m[1])}` };
  if ((m = /^(?:checkout|switch): moving from (\S+) to (\S+)$/.exec(subject))) {
    return { kind: 'checkout', label: `switch from ${m[1]} to ${m[2]}`, from: m[1], to: m[2] };
  }
  if ((m = /^reset: moving to (.+)$/s.exec(subject))) return { kind: 'reset', label: `reset to ${m[1]}` };
  if ((m = /^(rebase|pull)\b[^:]*\(finish\): returning to refs\/heads\/(.+)$/.exec(subject))) {
    const branch = m[2];
    return m[1] === 'rebase'
      ? { kind: 'rebase', label: `rebase of ${branch}`, branch }
      : { kind: 'pull', label: `pull (rebase) into ${branch}`, branch };
  }
  if (/^pull\b[^:(]*: /.test(subject)) return { kind: 'pull', label: 'pull' };
  if ((m = /^merge (\S+): /.exec(subject))) return { kind: 'merge', label: `merge of ${m[1]}` };
  if ((m = /^cherry-pick: (.*)$/s.exec(subject))) return { kind: 'cherry-pick', label: `cherry-pick of ${q(m[1])}` };
  if ((m = /^revert: (.*)$/s.exec(subject))) return { kind: 'revert', label: `revert ${q(m[1])}` };
  return null;
}

export interface UndoPlan {
  action: ReflogAction;
  /** Modal question and detail. */
  message: string;
  detail: string;
  /** Checked-out branch, or null when detached. */
  branch: string | null;
  /** Commit HEAD ends up on. */
  target: string;
  /** git arguments that perform the undo. */
  args: string[];
  /** How many of the commits the undo drops are already on the upstream. */
  pushed: number;
  upstream?: string;
}

const short = (sha: string) => sha.slice(0, 7);

async function tryGit(repo: string, args: string[]): Promise<string | null> {
  try {
    return (await git(repo, args)).trim() || null;
  } catch {
    return null;
  }
}

/** Works out how to undo the last HEAD reflog entry, or why it can't be. Runs nothing that changes the repo. */
export async function planUndo(repo: string): Promise<UndoPlan | { error: string }> {
  const head = await getHead(repo);
  if (!head) return { error: 'Nothing to undo yet.' };
  if (await operationInProgress(repo)) {
    return { error: 'A merge, rebase, cherry-pick or revert is in progress. Finish or abort it first.' };
  }
  const last = await tryGit(repo, ['reflog', '-n', '1', '--format=%H%x00%gs']);
  if (!last) return { error: 'Nothing to undo: HEAD has no reflog.' };
  const subject = last.slice(last.indexOf('\0') + 1);
  const action = classifyReflog(subject);
  if (!action) return { error: `The last action (${subject}) can't be undone from here.` };
  const branch = await tryGit(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);

  if (action.kind === 'checkout') {
    const from = action.from!;
    const isBranch = !!(await tryGit(repo, ['rev-parse', '--verify', '-q', `refs/heads/${from}`]));
    const target = await tryGit(repo, ['rev-parse', '--verify', '-q', `${from}^{commit}`]);
    if (!target) return { error: `Can't switch back: ${from} no longer exists.` };
    return {
      action,
      message: `Undo ${action.label}?`,
      detail: `This switches back to ${isBranch ? from : short(from)}.`,
      branch,
      target,
      args: isBranch ? ['switch', from] : ['switch', '--detach', target],
      pushed: 0,
    };
  }

  // A finished rebase leaves many HEAD entries; the branch's own reflog has one.
  const ref = action.branch ? `refs/heads/${action.branch}@{1}` : 'HEAD@{1}';
  const target = await tryGit(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  if (!target) return { error: `Can't find where ${branch ?? 'HEAD'} was before the ${action.label}.` };
  if (target === head) return { error: `Nothing to undo: the ${action.label} didn't move ${branch ?? 'HEAD'}.` };

  let pushed = 0;
  const upstream = branch ? await tryGit(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) : null;
  if (upstream) {
    const dropped = Number(await tryGit(repo, ['rev-list', '--count', 'HEAD', `^${target}`]));
    const unpushed = Number(await tryGit(repo, ['rev-list', '--count', 'HEAD', `^${target}`, `^${upstream}`]));
    pushed = dropped - unpushed;
  }
  return {
    action,
    message: `Undo ${action.label}?`,
    detail: `This moves ${branch ?? 'HEAD'} back to ${short(target)}. Uncommitted changes are kept.`,
    branch,
    target,
    args: ['reset', '--keep', target],
    pushed,
    ...(upstream ? { upstream } : {}),
  };
}

async function operationInProgress(repo: string): Promise<boolean> {
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (await tryGit(repo, ['rev-parse', '--verify', '-q', ref])) return true;
  }
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const p = await tryGit(repo, ['rev-parse', '--git-path', dir]);
    if (p && existsSync(path.resolve(repo, p))) return true;
  }
  return false;
}
