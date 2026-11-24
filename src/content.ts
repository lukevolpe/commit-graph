import * as path from 'node:path';
import * as vscode from 'vscode';
import { git } from './git';

/** Read-only documents for "file X at revision R", used as diff sides. */
export const SCHEME = 'commit-graph';

interface Query {
  repo: string;
  /** Empty = file doesn't exist on this side. */
  ref: string;
  path: string;
}

export function revisionUri(repo: string, relPath: string, ref: string): vscode.Uri {
  const q: Query = { repo, ref, path: relPath };
  // Path keeps the real file name so the editor picks the right language and tab title.
  return vscode.Uri.from({
    scheme: SCHEME,
    path: path.posix.join('/', ref ? ref.slice(0, 7) : 'empty', relPath),
    query: JSON.stringify(q),
  });
}

/**
 * The file as staged in the index (`git show :0:<path>`). Stamped per call: the index
 * changes under the same path, and VS Code caches provider documents by URI.
 */
export function indexUri(repo: string, relPath: string): vscode.Uri {
  const q: Query & { t: number } = { repo, ref: ':0', path: relPath, t: Date.now() };
  return vscode.Uri.from({ scheme: SCHEME, path: path.posix.join('/', 'index', relPath), query: JSON.stringify(q) });
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = JSON.parse(uri.query) as Query;
    if (!q.ref) return '';
    try {
      return await git(q.repo, ['show', `${q.ref}:${q.path}`]);
    } catch {
      return '';
    }
  }
}
