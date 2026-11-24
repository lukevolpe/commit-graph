import * as path from 'node:path';
import * as vscode from 'vscode';
import { getBlameCommit, getLineHistory, repoRoot } from './git';
import { GraphController, errorText } from './controller';

/** Shows the graph for `repo` (revealing it) and returns its controller. */
export type GraphOpener = (repo: string) => Promise<GraphController | undefined>;

interface Target {
  graph: GraphController;
  repo: string;
  /** Repo-relative, posix. */
  file: string;
}

/** Repo, graph and repo-relative path for a file Uri (explorer/editor menus) or the active editor. */
async function target(open: GraphOpener, uri?: vscode.Uri): Promise<Target | undefined> {
  uri ??= vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'file') {
    void vscode.window.showInformationMessage('Commit Graph: open a file from a git repository first.');
    return undefined;
  }
  let dir = uri.fsPath;
  try {
    if ((await vscode.workspace.fs.stat(uri)).type !== vscode.FileType.Directory) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir); // deleted file: its folder may still be in the repo
  }
  const repo = await repoRoot(dir).catch(() => undefined);
  if (!repo) {
    void vscode.window.showInformationMessage(`Commit Graph: ${path.basename(uri.fsPath)} isn't in a git repository.`);
    return undefined;
  }
  const file = path.relative(repo, uri.fsPath).split(path.sep).join('/');
  const graph = await open(repo);
  return graph && { graph, repo, file };
}

export function registerHistory(context: vscode.ExtensionContext, open: GraphOpener): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('commitGraph.showFileHistory', async (uri?: vscode.Uri) => {
      const t = await target(open, uri instanceof vscode.Uri ? uri : undefined);
      if (t) t.graph.showFileHistory(t.file || undefined);
    }),

    vscode.commands.registerCommand('commitGraph.showLineHistory', async (uri?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const t = await target(open, uri instanceof vscode.Uri ? uri : editor.document.uri);
      if (!t) return;
      const sel = editor.selection;
      const start = sel.start.line + 1;
      // A selection ending at column 0 doesn't include that line.
      const end = Math.max(start, sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1);
      let hashes: string[];
      try {
        hashes = await getLineHistory(t.repo, t.file, start, end);
      } catch (e) {
        void vscode.window.showInformationMessage(`Commit Graph: no line history (${errorText(e)}).`);
        return;
      }
      if (!hashes.length) {
        void vscode.window.showInformationMessage('Commit Graph: these lines have no committed history yet.');
        return;
      }
      // Line history runs from HEAD; a file history of another file would hide it.
      if (t.graph.historyFile && t.graph.historyFile !== t.file) t.graph.showFileHistory(undefined);
      const lines = start === end ? `${start}` : `${start}–${end}`;
      t.graph.showLineMarks(`${path.posix.basename(t.file)}:${lines}`, hashes);
    }),

    vscode.commands.registerCommand('commitGraph.revealLineCommit', async (uri?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const t = await target(open, uri instanceof vscode.Uri ? uri : editor.document.uri);
      if (!t) return;
      const hash = await getBlameCommit(t.repo, t.file, editor.selection.active.line + 1);
      if (!hash) {
        void vscode.window.showInformationMessage("Commit Graph: this line isn't committed yet.");
        return;
      }
      if (t.graph.historyFile && t.graph.historyFile !== t.file) t.graph.showFileHistory(undefined);
      t.graph.revealCommit(hash);
    }),
  );
}
