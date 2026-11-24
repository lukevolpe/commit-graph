import * as path from 'node:path';
import { git } from './git';

/** A linked or main working tree of the repository. */
export interface Worktree {
  path: string;
  /** Commit checked out there; empty for an unborn branch. */
  head: string;
  /** Local branch name; null when detached. */
  branch: string | null;
  detached: boolean;
  locked: boolean;
  /** Its folder is gone; `git worktree prune` would drop it. */
  prunable: boolean;
}

/** Parses `git worktree list --porcelain`. Bare entries (no working tree) are left out. */
export function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines[0]?.startsWith('worktree ')) continue;
    const wt: Worktree = { path: lines[0].slice(9), head: '', branch: null, detached: false, locked: false, prunable: false };
    let bare = false;
    for (const line of lines.slice(1)) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'HEAD') wt.head = value;
      else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') wt.detached = true;
      else if (key === 'locked') wt.locked = true;
      else if (key === 'prunable') wt.prunable = true;
      else if (key === 'bare') bare = true;
    }
    if (!bare) list.push(wt);
  }
  return list;
}

/** All working trees, main first. */
export async function getWorktrees(cwd: string): Promise<Worktree[]> {
  return parseWorktrees(await git(cwd, ['worktree', 'list', '--porcelain']));
}

/** Same folder, ignoring slash style (git prints `C:/x` on Windows) and case on Windows. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** The worktree other than `here` that has `branch` checked out. */
export function otherWorktree(list: Worktree[], branch: string, here: string): Worktree | undefined {
  return list.find((w) => w.branch === branch && !samePath(w.path, here));
}

/** Suggested folder for a new worktree: `<repo>-<branch>` next to the repo. */
export function defaultWorktreePath(repo: string, branch: string): string {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return path.join(path.dirname(repo), `${path.basename(repo)}-${slug}`);
}
