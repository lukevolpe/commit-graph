import * as vscode from 'vscode';
import { GraphController } from './controller';
import { pickRepo } from './repos';

export const VIEW_ID = 'commitGraph.view';

/** Opens (or reveals) the graph for `repo` in an editor tab. */
export function openInEditor(context: vscode.ExtensionContext, repo: string): void {
  const existing = GraphController.forRepo(repo, 'editor');
  if (existing) return existing.reveal();

  const panel = vscode.window.createWebviewPanel('commitGraph', 'Commit Graph', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  const controller = new GraphController(
    {
      kind: 'editor',
      webview: panel.webview,
      reveal: () => panel.reveal(),
      setTitle: (name) => (panel.title = `Graph: ${name}`),
    },
    context,
    repo,
  );
  panel.onDidDispose(() => controller.dispose());
}

/** The graph as a view: a tab in the bottom panel by default, draggable into either sidebar. */
export class GraphViewProvider implements vscode.WebviewViewProvider {
  controller: GraphController | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    const repo = await pickRepo({ quiet: true });
    if (!repo) {
      view.webview.html = `<!DOCTYPE html><html><body style="padding:12px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family)">Open a folder that's in a git repository to see its commit graph.</body></html>`;
      return;
    }
    const controller = new GraphController(
      {
        kind: 'view',
        webview: view.webview,
        reveal: () => view.show(true),
        setTitle: (name) => (view.description = name),
      },
      this.context,
      repo,
    );
    this.controller = controller;
    view.onDidChangeVisibility(() => {
      if (view.visible) GraphController.active = controller;
    });
    view.onDidDispose(() => {
      controller.dispose();
      if (this.controller === controller) this.controller = undefined;
    });
  }
}
