import { git, remoteWebBase } from './git';

// Remote hosting (pull request pages) and remote management.

export interface PrDraft {
  title: string;
  /** Undefined leaves the host's own default (its PR template, or empty). */
  body?: string;
}

/**
 * Browser page that starts a pull (merge) request of `branch` into `target`; undefined for unknown hosts.
 * GitHub and GitLab take a title and description from the link; Bitbucket has no such parameters.
 */
export function pullRequestUrl(remoteUrl: string, branch: string, target: string, draft?: PrDraft): string | undefined {
  const base = remoteWebBase(remoteUrl);
  if (!base) return undefined;
  const host = new URL(base).hostname;
  const q = encodeURIComponent;
  const extra = (title: string, body: string) =>
    (draft ? `&${q(title)}=${q(draft.title)}` : '') + (draft?.body ? `&${q(body)}=${q(draft.body)}` : '');
  if (host.includes('github')) {
    const path = (s: string) => s.split('/').map(q).join('/');
    return `${base}/compare/${path(target)}...${path(branch)}?expand=1${extra('title', 'body')}`;
  }
  if (host.includes('gitlab')) {
    return (
      `${base}/-/merge_requests/new?${q('merge_request[source_branch]')}=${q(branch)}&${q('merge_request[target_branch]')}=${q(target)}` +
      extra('merge_request[title]', 'merge_request[description]')
    );
  }
  if (host.includes('bitbucket')) return `${base}/pull-requests/new?source=${q(branch)}&dest=${q(target)}`;
  return undefined;
}

const MAX_LISTED = 30;

/**
 * Title and description for a new pull request, the way GitHub drafts one: a single commit gives its
 * own subject and body; several give a title from the branch name and a list of their subjects.
 */
export function prDraft(branch: string, commits: { subject: string; body: string }[]): PrDraft {
  if (commits.length === 1) return { title: commits[0].subject, body: commits[0].body.trim() || undefined };
  const name = branch.slice(branch.lastIndexOf('/') + 1).replace(/[-_]+/g, ' ').trim() || branch;
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  if (!commits.length) return { title };
  const lines = commits.slice(0, MAX_LISTED).map((c) => `- ${c.subject}`);
  if (commits.length > MAX_LISTED) lines.push(`- …and ${commits.length - MAX_LISTED} more`);
  return { title, body: lines.join('\n') };
}

/** Commits on `head` that `base` lacks, oldest first. */
export async function prCommits(cwd: string, base: string, head: string): Promise<{ subject: string; body: string }[]> {
  const out = await git(cwd, ['log', '--reverse', '--no-merges', '--format=%s%x00%b%x1e', `${base}..${head}`]);
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [subject, body = ''] = r.split('\x00');
      return { subject, body: body.trim() };
    });
}

/** Whether `ref` has a default PR/MR template, which a prefilled description would replace. */
export async function hasPrTemplate(cwd: string, ref: string): Promise<boolean> {
  try {
    const files = (await git(cwd, ['ls-tree', '-r', '--name-only', ref])).split('\n');
    return files.some((f) =>
      /^(\.github\/|docs\/)?pull_request_template(\.md|\.txt)?$/i.test(f) ||
      /^(\.github\/|docs\/)?pull_request_template\//i.test(f) ||
      /^\.gitlab\/merge_request_templates\/default\.md$/i.test(f),
    );
  } catch {
    return false;
  }
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
