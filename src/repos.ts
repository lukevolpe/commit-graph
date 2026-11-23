import * as path from 'node:path';
import * as vscode from 'vscode';
import { repoRoot } from './git';

/** Git repos for the workspace folders, deduplicated. */
export async function workspaceRepos(): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots = await Promise.all(folders.map((f) => repoRoot(f.uri.fsPath).catch(() => null)));
  return [...new Set(roots.filter((r): r is string => !!r))];
}

/**
 * Picks the repository to show: the active file's repo, else the only workspace repo,
 * else asks (unless `quiet`, which takes the first).
 */
export async function pickRepo(opts: { quiet?: boolean; ask?: boolean } = {}): Promise<string | undefined> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!opts.ask && doc?.uri.scheme === 'file') {
    const r = await repoRoot(path.dirname(doc.uri.fsPath)).catch(() => null);
    if (r) return r;
  }
  const repos = await workspaceRepos();
  if (repos.length === 0) {
    if (!opts.quiet) void vscode.window.showErrorMessage('Commit Graph: no git repository in this workspace.');
    return undefined;
  }
  if (repos.length === 1 || opts.quiet) return repos[0];
  const pick = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: path.basename(r), description: r, repo: r })),
    { placeHolder: 'Show the commit graph for…' },
  );
  return pick?.repo;
}
