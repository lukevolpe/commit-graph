import * as vscode from 'vscode';
import { repoRoot } from './git';
import { GraphController } from './controller';
import { GraphViewProvider, VIEW_ID, openInEditor } from './hosts';
import { RevisionContentProvider, SCHEME } from './content';
import { registerActions } from './actions';
import { pickRepo } from './repos';
import { registerHistory } from './history';
import { registerRebaseEditor } from './rebaseEditor';

export function activate(context: vscode.ExtensionContext): void {
  const view = new GraphViewProvider(context);

  /** Repo from a Source Control title-button click, else the usual pick. */
  const repoFrom = async (scm?: { rootUri?: vscode.Uri }) =>
    scm?.rootUri ? repoRoot(scm.rootUri.fsPath).catch(() => undefined) : pickRepo();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider()),
    vscode.window.registerWebviewViewProvider(VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }),

    // Show in the view (panel tab or wherever the user dragged it).
    vscode.commands.registerCommand('commitGraph.show', async (scm?: { rootUri?: vscode.Uri }) => {
      const repo = scm?.rootUri ? await repoFrom(scm) : undefined;
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      if (repo) view.controller?.setRepo(repo);
    }),

    vscode.commands.registerCommand('commitGraph.openInEditor', async (scm?: { rootUri?: vscode.Uri }) => {
      const repo = (scm?.rootUri ? await repoFrom(scm) : undefined) ?? view.controller?.repo ?? (await pickRepo());
      if (repo) openInEditor(context, repo);
    }),

    vscode.commands.registerCommand('commitGraph.switchRepo', async () => {
      const repo = await pickRepo({ ask: true });
      if (repo) GraphController.active?.setRepo(repo);
    }),

    vscode.commands.registerCommand('commitGraph.refresh', () => GraphController.active?.refresh()),
    vscode.commands.registerCommand('commitGraph.goToHead', () => GraphController.active?.post({ type: 'goToHead' })),
    vscode.commands.registerCommand('commitGraph.focusSearch', () => GraphController.active?.post({ type: 'focusSearch' })),
  );

  registerActions(context);
  registerHistory(context, async (repo) => {
    const existing = GraphController.active?.repo === repo ? GraphController.active : GraphController.forRepo(repo);
    if (existing) {
      existing.reveal();
      return existing;
    }
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    // The view resolves asynchronously the first time it's shown.
    for (let i = 0; i < 50 && !view.controller; i++) await new Promise((r) => setTimeout(r, 100));
    view.controller?.setRepo(repo);
    return view.controller;
  });
  registerRebaseEditor(context);
}

export function deactivate(): void {}
