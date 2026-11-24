import { git, remoteWebBase } from './git';

// Remote hosting (pull request pages) and remote management.

/** Browser page that starts a pull (merge) request of `branch` into `target`; undefined for unknown hosts. */
export function pullRequestUrl(remoteUrl: string, branch: string, target: string): string | undefined {
  const base = remoteWebBase(remoteUrl);
  if (!base) return undefined;
  const host = new URL(base).hostname;
  const q = encodeURIComponent;
  if (host.includes('github')) {
    const path = (s: string) => s.split('/').map(q).join('/');
    return `${base}/compare/${path(target)}...${path(branch)}?expand=1`;
  }
  if (host.includes('gitlab')) {
    return `${base}/-/merge_requests/new?${q('merge_request[source_branch]')}=${q(branch)}&${q('merge_request[target_branch]')}=${q(target)}`;
  }
  if (host.includes('bitbucket')) return `${base}/pull-requests/new?source=${q(branch)}&dest=${q(target)}`;
  return undefined;
}

/** Splits `origin/feat/x` into remote and branch; remote names may contain slashes, so the longest match wins. */
export function splitRemoteRef(ref: string, remotes: string[]): { remote: string; branch: string } | null {
  const remote = remotes
    .filter((r) => ref.startsWith(`${r}/`) && ref.length > r.length + 1)
    .sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, branch: ref.slice(remote.length + 1) } : null;
}

/** True if a failed push says the remote has commits we don't (diverged, or not fetched yet). */
export function isNonFastForward(error: string): boolean {
  return /\[rejected\].*\((non-fast-forward|fetch first)\)/.test(error);
}

export interface Remote {
  name: string;
  /** Fetch URL. */
  url: string;
}

export async function getRemotes(cwd: string): Promise<Remote[]> {
  const out = await git(cwd, ['remote', '-v']);
  const remotes: Remote[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\t(.*) \(fetch\)$/);
    if (m) remotes.push({ name: m[1], url: m[2] });
  }
  return remotes;
}

/** The remote's default branch (from `<remote>/HEAD`, else `main` or `master` if present), without the remote prefix. */
export async function defaultBranch(cwd: string, remote: string): Promise<string | null> {
  const prefix = `refs/remotes/${remote}/`;
  try {
    const ref = (await git(cwd, ['symbolic-ref', '-q', `${prefix}HEAD`])).trim();
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  } catch {
    // no <remote>/HEAD
  }
  for (const name of ['main', 'master']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '-q', `${prefix}${name}`]);
      return name;
    } catch {
      // not there
    }
  }
  return null;
}

/** Runs `git remote prune`; returns the stale tracking branches it removed. */
export async function pruneRemote(cwd: string, remote: string): Promise<string[]> {
  const out = await git(cwd, ['remote', 'prune', remote]);
  return [...out.matchAll(/^ \* \[(?:would prune|pruned)\] (.+)$/gm)].map((m) => m[1]);
}
