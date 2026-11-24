/**
 * Interactive rebase without a terminal (pure + git; no vscode import, so it's testable).
 *
 * How it runs: `git rebase -i <base>` with
 *  - GIT_SEQUENCE_EDITOR = `cp '<our todo>'`: git calls it with its todo path, so our todo replaces git's;
 *  - GIT_EDITOR = true (and core.editor=true): squash keeps git's combined message as is.
 * Reword is written as `pick` + `exec git commit --amend --only -F <file>`, so the new message comes
 * from a file rather than an editor. Everything else is a plain todo command. If the rebase stops
 * (edit, conflicts, failed exec) it's an ordinary git rebase: `git rebase --continue` / `--abort` work.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { git, gitDirs } from './git';

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface TodoRow {
  sha: string;
  action: RebaseAction;
  /** New full message; used when action is reword. */
  message?: string;
}

/** Single-quotes for sh (git runs exec lines and editors through sh, also on Windows). */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Why git would refuse this todo, or null if it's fine. Mirrored in media/rebase.js for live feedback. */
export function validateTodo(rows: TodoRow[]): string | null {
  if (!rows.length) return 'There are no commits to rebase.';
  const first = rows.find((r) => r.action !== 'drop');
  if (first && (first.action === 'squash' || first.action === 'fixup')) {
    return `The first commit can't be ${first.action}: there's no commit above it to fold into.`;
  }
  const empty = rows.find((r) => r.action === 'reword' && !r.message?.trim());
  if (empty) return `Reworded commit ${empty.sha.slice(0, 7)} needs a message.`;
  return null;
}

/** The todo git will run. `messageFile(row)` is where a reword row's message is written. */
export function buildTodo(rows: TodoRow[], messageFile: (row: TodoRow) => string): string {
  const lines: string[] = [];
  for (const r of rows) {
    if (r.action === 'reword') {
      lines.push(`pick ${r.sha}`);
      lines.push(`exec git commit --amend --only --no-verify --allow-empty -F ${shQuote(messageFile(r))}`);
    } else {
      lines.push(`${r.action} ${r.sha}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** True while a rebase (ours or anyone's) is stopped mid-way. */
export async function rebaseInProgress(repo: string): Promise<boolean> {
  const { gitDir } = await gitDirs(repo);
  return existsSync(path.join(gitDir, 'rebase-merge')) || existsSync(path.join(gitDir, 'rebase-apply'));
}

export interface RebaseCommit {
  hash: string;
  subject: string;
  /** Full message, for reword. */
  message: string;
  author: string;
  /** Unix seconds (author date). */
  date: number;
}

export type RebasePlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** Checked-out branch; null when detached. */
      branch: string | null;
      /** Commits after `base` up to HEAD, oldest first (git's todo order). */
      commits: RebaseCommit[];
      /** How many of them are on the upstream already. */
      pushed: number;
    };

/** What `git rebase -i <base>` would rewrite, or why we won't offer it. */
export async function planRebase(repo: string, base: string): Promise<RebasePlan> {
  if (await rebaseInProgress(repo)) {
    return { ok: false, reason: 'A rebase is already in progress. Continue or abort it first.' };
  }
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const sha = (await git(repo, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
  if (sha === head) return { ok: false, reason: "That's HEAD: there are no commits after it to rebase." };
  try {
    await git(repo, ['merge-base', '--is-ancestor', sha, 'HEAD']);
  } catch {
    return { ok: false, reason: 'Pick a commit on the current branch (an ancestor of HEAD).' };
  }
  const range = `${sha}..HEAD`;
  if ((await git(repo, ['rev-list', '--merges', '-n1', range, '--'])).trim()) {
    return { ok: false, reason: "Those commits include a merge, which this editor can't rebase." };
  }
  const out = await git(repo, ['log', '--reverse', '--format=%H%x1f%an%x1f%at%x1f%B%x1e', range, '--']);
  const commits = out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, author, date, ...msg] = r.split('\x1f');
      const message = msg.join('\x1f').trimEnd();
      return { hash, author, date: Number(date), message, subject: message.split('\n')[0] };
    });
  let pushed = 0;
  try {
    const unpushed = Number((await git(repo, ['rev-list', '--count', range, '^@{upstream}', '--'])).trim());
    pushed = commits.length - unpushed;
  } catch {
    // no upstream
  }
  let branch: string | null = null;
  try {
    branch = (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null;
  } catch {
    // detached
  }
  return { ok: true, branch, commits, pushed };
}

/**
 * Runs the todo. 'done' when finished, 'stopped' when git paused (edit, conflict, failed exec) and
 * left a normal rebase in progress. Throws when git refused to start (e.g. uncommitted changes).
 */
export async function runRebase(repo: string, base: string, rows: TodoRow[]): Promise<'done' | 'stopped'> {
  const problem = validateTodo(rows);
  if (problem) throw new Error(problem);
  const { gitDir } = await gitDirs(repo);
  // Kept in the git dir, not /tmp: reword files must outlive a stop (edit, conflict) until --continue.
  const work = path.join(gitDir, 'commit-graph-rebase');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const posix = (p: string) => p.replace(/\\/g, '/');
  const messageFile = (r: TodoRow) => posix(path.join(work, `${r.sha}.msg`));
  for (const r of rows) if (r.action === 'reword') writeFileSync(messageFile(r), r.message!.trimEnd() + '\n');
  const todo = path.join(work, 'git-rebase-todo');
  writeFileSync(todo, buildTodo(rows, messageFile));

  const env = {
    ...process.env,
    GIT_SEQUENCE_EDITOR: `cp ${shQuote(posix(todo))}`,
    GIT_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        'git',
        ['-c', 'core.editor=true', 'rebase', '-i', base],
        { cwd: repo, env, maxBuffer: 64 * 1024 * 1024 },
        (err, _stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()),
      ),
    );
  } catch (e) {
    if (await rebaseInProgress(repo)) return 'stopped';
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
  if (await rebaseInProgress(repo)) return 'stopped';
  rmSync(work, { recursive: true, force: true });
  return 'done';
}
