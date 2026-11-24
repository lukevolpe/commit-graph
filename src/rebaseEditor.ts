import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { git } from './git';
import { GraphController, WIP, errorText } from './controller';
import { RebaseCommit, TodoRow, planRebase, runRebase, validateTodo } from './rebase';

type InMessage = { type: 'ready' } | { type: 'start'; rows: TodoRow[] } | { type: 'cancel' };

const short = (sha: string) => sha.slice(0, 7);

/** One editor per repo: opening another replaces it. */
const open = new Map<string, vscode.WebviewPanel>();

/** Right-click → Interactive Rebase From Here…: `git rebase -i <sha>` through an editor tab. */
export function registerRebaseEditor(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('commitGraph.interactiveRebase', async (ctx: { sha?: string } = {}) => {
      const graph = GraphController.active;
      if (!graph || !ctx.sha || ctx.sha === WIP) return;
      try {
        await openRebaseEditor(context, graph, ctx.sha);
      } catch (e) {
        void vscode.window.showErrorMessage(errorText(e));
      }
    }),
  );
}

async function openRebaseEditor(context: vscode.ExtensionContext, graph: GraphController, base: string): Promise<void> {
  const repo = graph.repo;
  const plan = await planRebase(repo, base);
  if (!plan.ok) {
    void vscode.window.showWarningMessage(plan.reason);
    return;
  }
  if (plan.pushed) {
    const n = plan.pushed === 1 ? '1 of these commits is' : `${plan.pushed} of these commits are`;
    const go = 'Rebase Anyway';
    const pick = await vscode.window.showWarningMessage(
      `${n} already pushed.`,
      { modal: true, detail: 'Rewriting them means force-pushing, which affects anyone who already pulled them.' },
      go,
    );
    if (pick !== go) return;
  }

  open.get(repo)?.dispose();
  const branch = plan.branch ?? 'HEAD';
  const panel = vscode.window.createWebviewPanel('commitGraph.rebase', `Rebase ${branch}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  panel.webview.html = html(panel.webview, context);
  open.set(repo, panel);
  panel.onDidDispose(() => {
    if (open.get(repo) === panel) open.delete(repo);
  });

  const baseSubject = (await git(repo, ['log', '-1', '--format=%s', base, '--'])).trim();
  const post = (m: unknown) => void panel.webview.postMessage(m);
  const head = plan.commits[plan.commits.length - 1].hash;

  panel.webview.onDidReceiveMessage(async (m: InMessage) => {
    if (m.type === 'ready') {
      post({ type: 'init', branch, base: { hash: base, subject: baseSubject }, commits: plan.commits });
    } else if (m.type === 'cancel') {
      panel.dispose();
    } else if (m.type === 'start') {
      const problem = validateTodo(m.rows) ?? (await stale(repo, head, plan.commits, m.rows));
      if (problem) return post({ type: 'error', message: problem });
      post({ type: 'busy', busy: true });
      try {
        const status = await graph.withBusy('Rebasing', () =>
          vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Rebasing ${branch}` }, () =>
            runRebase(repo, base, m.rows),
          ),
        );
        panel.dispose();
        if (status === 'done') void vscode.window.setStatusBarMessage(`$(check) Rebased ${branch}`, 3000);
        else void stopped(repo);
      } catch (e) {
        post({ type: 'busy', busy: false });
        post({ type: 'error', message: errorText(e) });
      } finally {
        graph.refresh();
      }
    }
  });
}

/** Refuses a todo that no longer matches the branch (it moved while the editor was open). */
async function stale(repo: string, head: string, commits: RebaseCommit[], rows: TodoRow[]): Promise<string | null> {
  const now = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const same = rows.length === commits.length && commits.every((c) => rows.some((r) => r.sha === c.hash));
  return now === head && same ? null : 'The branch changed since this editor opened. Close it and start again.';
}

/** The rebase paused (edit or conflicts). It's a normal git rebase now: continue or abort it as usual. */
async function stopped(repo: string): Promise<void> {
  const conflicts = (await git(repo, ['diff', '--name-only', '--diff-filter=U'])).trim();
  const head = short((await git(repo, ['rev-parse', 'HEAD'])).trim());
  const abort = 'Abort Rebase';
  const scm = 'Open Source Control';
  const msg = conflicts
    ? 'Rebase paused: conflicts need resolving. Resolve and stage them, then continue the rebase (git rebase --continue).'
    : `Rebase paused at ${head} for editing. Amend or add commits, then continue the rebase (git rebase --continue).`;
  const pick = await vscode.window.showWarningMessage(msg, scm, abort);
  if (pick === scm) void vscode.commands.executeCommand('workbench.view.scm');
  if (pick === abort) {
    try {
      await git(repo, ['rebase', '--abort']);
    } catch (e) {
      void vscode.window.showErrorMessage(`Abort failed: ${errorText(e)}`);
    }
    GraphController.forRepo(repo)?.refresh();
  }
}

function html(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
  const nonce = randomBytes(16).toString('hex');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('codicons/codicon.css')}">
<link rel="stylesheet" href="${media('rebase.css')}">
</head>
<body>
  <div class="progress" id="progress"></div>
  <header class="head">
    <div>
      <h1 id="title">Interactive Rebase</h1>
      <div class="muted" id="subtitle"></div>
    </div>
    <span class="spacer"></span>
    <div class="keys muted">Oldest first · <kbd>Alt</kbd>+<kbd>↑</kbd><kbd>↓</kbd> or drag to move · <kbd>P</kbd> <kbd>R</kbd> <kbd>E</kbd> <kbd>S</kbd> <kbd>F</kbd> <kbd>D</kbd> set action · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> start</div>
  </header>
  <main id="rows" role="list" aria-label="Rebase todo, oldest first"></main>
  <footer class="foot">
    <div class="error" id="error" role="alert"></div>
    <span class="summary" id="summary"></span>
    <span class="spacer"></span>
    <button class="secondary" id="cancel">Cancel</button>
    <button class="primary" id="start">Start Rebase</button>
  </footer>
  <script nonce="${nonce}" src="${media('rebase.js')}"></script>
</body>
</html>`;
}
