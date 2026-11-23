import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  Commit,
  FileChange,
  Scope,
  SearchEntry,
  getDetails,
  getHead,
  getLog,
  getSearchIndex,
  getWorkingChanges,
  gitDirs,
  search,
} from './git';
import { GraphLayout, GraphRow } from './lanes';
import { revisionUri } from './content';

const PAGE = 500;
/** Hash used for the uncommitted-changes row. */
export const WIP = 'WORKING_TREE';

type InMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'loadMore' }
  | { type: 'loadUntil'; hash: string }
  | { type: 'select'; hash: string }
  | { type: 'openDiff'; hash: string; parent: string | null; file: FileChange }
  | { type: 'openAll'; hash: string; parent: string | null; files: FileChange[] }
  | { type: 'openFile'; path: string }
  | { type: 'search'; query: string }
  | { type: 'setScope'; scope: Scope }
  | { type: 'fetch' }
  | { type: 'copy'; text: string; label: string }
  | { type: 'layout'; width: number; height: number };

type Row = Commit & { graph: GraphRow; wip?: boolean };

/** Where the graph lives: an editor tab or a panel/sidebar view. */
export interface GraphHost {
  kind: 'editor' | 'view';
  webview: vscode.Webview;
  reveal(): void;
  setTitle(repoName: string): void;
}

/** Drives one graph webview. Hosts (editor tab, panel view) only own the webview's lifecycle. */
export class GraphController {
  /** The graph the user touched last: target of commands and right-click actions. */
  static active: GraphController | undefined;
  private static all = new Set<GraphController>();

  static forRepo(repo: string, kind?: GraphHost['kind']): GraphController | undefined {
    for (const c of GraphController.all) if (c._repo === repo && (!kind || c.host.kind === kind)) return c;
    return undefined;
  }

  private commits: Commit[] = [];
  private layout = new GraphLayout();
  private head: string | null = null;
  private wipCount = 0;
  private done = false;
  private scope: Scope;
  private searchIndex: Promise<SearchEntry[]> | undefined;
  private lastQuery = '';
  private detailsSeq = 0;
  /** Serializes loads so pages never interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private disposables: vscode.Disposable[] = [];
  /** Watchers for the current repo; replaced on repo switch. */
  private repoDisposables: vscode.Disposable[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private wipTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly host: GraphHost,
    private readonly context: vscode.ExtensionContext,
    private _repo: string,
  ) {
    this.scope = context.workspaceState.get<Scope>('commitGraph.scope', 'all');
    host.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };
    host.webview.html = this.html();
    host.setTitle(path.basename(_repo));
    host.webview.onDidReceiveMessage(
      (m: InMessage) => {
        GraphController.active = this;
        this.onMessage(m);
      },
      null,
      this.disposables,
    );
    GraphController.all.add(this);
    GraphController.active = this;
    void this.watch();
  }

  get repo(): string {
    return this._repo;
  }

  /** Points this graph at another repository. */
  setRepo(repo: string): void {
    if (repo === this._repo) return;
    this._repo = repo;
    this.repoDisposables.forEach((d) => d.dispose());
    this.repoDisposables = [];
    this.lastQuery = '';
    this.host.setTitle(path.basename(repo));
    this.post({ type: 'repoChanged' });
    void this.watch();
    void this.enqueue(() => this.reload(false));
  }

  reveal(): void {
    this.host.reveal();
  }

  /** Full reload keeping scroll position: after refs move. */
  refresh(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.enqueue(() => this.reload(true)), 250);
  }

  /** Cheap refresh of the uncommitted-changes row: after saves and index writes. */
  refreshWip(): void {
    clearTimeout(this.wipTimer);
    this.wipTimer = setTimeout(() => this.enqueue(() => this.updateWip()), 400);
  }

  post(msg: unknown): void {
    void this.host.webview.postMessage(msg);
  }

  /** Shows a spinner in the webview while `fn` runs. */
  async withBusy<T>(label: string, fn: () => PromiseLike<T>): Promise<T> {
    this.post({ type: 'busy', busy: true, label });
    try {
      return await fn();
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private async watch(): Promise<void> {
    const repo = this._repo;
    let dirs: { gitDir: string; commonDir: string };
    try {
      dirs = await gitDirs(repo);
    } catch {
      return;
    }
    if (repo !== this._repo) return; // switched while waiting
    const bag = this.repoDisposables;
    const w = (base: string, glob: string, fn: () => void) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
      watcher.onDidChange(fn, null, bag);
      watcher.onDidCreate(fn, null, bag);
      watcher.onDidDelete(fn, null, bag);
      bag.push(watcher);
    };
    const reload = () => this.refresh();
    const wip = () => this.refreshWip();
    w(dirs.gitDir, '{HEAD,MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD}', reload);
    w(dirs.commonDir, '{packed-refs,refs/**}', reload);
    w(dirs.gitDir, 'index', wip);
    const inRepo = (uri: vscode.Uri) => uri.scheme === 'file' && uri.fsPath.startsWith(repo + path.sep);
    bag.push(
      vscode.workspace.onDidSaveTextDocument((d) => inRepo(d.uri) && wip()),
      vscode.workspace.onDidCreateFiles((e) => e.files.some(inRepo) && wip()),
      vscode.workspace.onDidDeleteFiles((e) => e.files.some(inRepo) && wip()),
      vscode.workspace.onDidRenameFiles((e) => e.files.some((f) => inRepo(f.newUri)) && wip()),
      vscode.window.onDidChangeWindowState((s) => s.focused && wip()),
    );
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T | void> {
    const next = this.queue.then(fn).catch((e) => this.post({ type: 'error', message: errorText(e) }));
    this.queue = next;
    return next;
  }

  private onMessage(msg: InMessage): void {
    switch (msg.type) {
      case 'ready':
        void this.enqueue(() => this.reload(false));
        break;
      case 'refresh':
        void this.enqueue(() => this.withBusy('Refreshing', () => this.reload(true)));
        break;
      case 'loadMore':
        void this.enqueue(() => this.loadMore());
        break;
      case 'loadUntil':
        void this.enqueue(() => this.withBusy('Finding commit', () => this.loadUntil(msg.hash)));
        break;
      case 'select':
        void this.sendDetails(msg.hash);
        break;
      case 'openDiff':
        void this.openDiff(msg.hash, msg.parent, msg.file);
        break;
      case 'openAll':
        void this.openAll(msg.hash, msg.parent, msg.files);
        break;
      case 'openFile':
        void vscode.window.showTextDocument(vscode.Uri.file(path.join(this.repo, msg.path)), { preview: true });
        break;
      case 'search':
        void this.runSearch(msg.query);
        break;
      case 'setScope':
        this.scope = msg.scope;
        void this.context.workspaceState.update('commitGraph.scope', msg.scope);
        void this.enqueue(() => this.withBusy('Loading', () => this.reload(false)));
        break;
      case 'fetch':
        void vscode.commands.executeCommand('commitGraph.fetch');
        break;
      case 'layout':
        void this.context.globalState.update(this.layoutKey, { width: msg.width, height: msg.height });
        break;
      case 'copy':
        void vscode.env.clipboard.writeText(msg.text);
        void vscode.window.setStatusBarMessage(`$(check) Copied ${msg.label}`, 2000);
        break;
    }
  }

  /** Details pane size, remembered per host kind across closes and reloads. */
  private get layoutKey(): string {
    return `commitGraph.layout.${this.host.kind}`;
  }

  // ---- loading -------------------------------------------------------------

  private async reload(keep: boolean): Promise<void> {
    const count = keep ? Math.max(PAGE, this.commits.length) : PAGE;
    this.searchIndex = undefined;
    this.head = await getHead(this.repo);
    this.wipCount = this.head ? (await getWorkingChanges(this.repo)).length : 0;
    this.commits = await getLog(this.repo, this.scope, 0, count);
    this.done = this.commits.length < count;
    this.layout = new GraphLayout();
    const rows = this.toRows(this.commits, true);
    this.post({ type: 'rows', mode: 'reset', keep, rows, done: this.done, head: this.head, scope: this.scope });
    if (this.lastQuery) await this.runSearch(this.lastQuery);
  }

  private async loadMore(): Promise<Row[]> {
    if (this.done) return [];
    const page = await getLog(this.repo, this.scope, this.commits.length, PAGE);
    this.commits.push(...page);
    this.done = page.length < PAGE;
    const rows = this.toRows(page, false);
    this.post({ type: 'rows', mode: 'append', rows, done: this.done });
    return rows;
  }

  private async loadUntil(hash: string): Promise<void> {
    while (!this.done && !this.commits.some((c) => c.hash === hash)) {
      await this.loadMore();
    }
    this.post({ type: 'reveal', hash });
  }

  /** Lays out a batch of commits; the first batch gets the uncommitted row on top. */
  private toRows(commits: Commit[], first: boolean): Row[] {
    const batch: (Commit & { wip?: boolean })[] = [...commits];
    if (first && this.wipCount && this.head) batch.unshift(this.wipCommit());
    const graph = this.layout.add(batch);
    return batch.map((c, i) => ({ ...c, graph: graph[i] }));
  }

  private wipCommit(): Commit & { wip: true } {
    return {
      hash: WIP,
      parents: [this.head!],
      author: '',
      email: '',
      date: Date.now() / 1000,
      refs: [],
      subject: `${this.wipCount} uncommitted ${this.wipCount === 1 ? 'change' : 'changes'}`,
      wip: true,
    };
  }

  private async updateWip(): Promise<void> {
    const head = await getHead(this.repo);
    if (head !== this.head) return this.reload(true);
    const count = head ? (await getWorkingChanges(this.repo)).length : 0;
    const toggled = !count !== !this.wipCount;
    this.wipCount = count;
    if (toggled) return this.reload(true);
    if (count) this.post({ type: 'wip', subject: this.wipCommit().subject });
  }

  // ---- details & diffs -----------------------------------------------------

  private async sendDetails(hash: string): Promise<void> {
    const seq = ++this.detailsSeq;
    try {
      const details =
        hash === WIP
          ? { hash: WIP, wip: true, parents: this.head ? [this.head] : [], files: await getWorkingChanges(this.repo) }
          : await getDetails(this.repo, hash);
      if (seq === this.detailsSeq) this.post({ type: 'details', details });
    } catch (e) {
      if (seq === this.detailsSeq) this.post({ type: 'details', hash, error: errorText(e) });
    }
  }

  private diffSides(hash: string, parent: string | null, f: FileChange): [vscode.Uri, vscode.Uri] {
    const empty = (p: string) => revisionUri(this.repo, p, '');
    const leftPath = f.oldPath ?? f.path;
    const left = f.status === 'A' || !parent ? empty(leftPath) : revisionUri(this.repo, leftPath, parent);
    let right: vscode.Uri;
    if (f.status === 'D') right = empty(f.path);
    else if (hash === WIP) right = vscode.Uri.file(path.join(this.repo, f.path));
    else right = revisionUri(this.repo, f.path, hash);
    return [left, right];
  }

  private async openDiff(hash: string, parent: string | null, f: FileChange): Promise<void> {
    const [left, right] = this.diffSides(hash, parent, f);
    const name = path.posix.basename(f.path);
    const rightLabel = hash === WIP ? 'Working Tree' : hash.slice(0, 7);
    const leftLabel = parent ? (hash === WIP ? 'HEAD' : parent.slice(0, 7)) : 'empty';
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${leftLabel} ↔ ${rightLabel})`, {
      preview: true,
    });
  }

  private async openAll(hash: string, parent: string | null, files: FileChange[]): Promise<void> {
    const resources = files.map((f) => {
      const [left, right] = this.diffSides(hash, parent, f);
      return [vscode.Uri.file(path.join(this.repo, f.path)), left, right];
    });
    const title = hash === WIP ? 'Uncommitted Changes' : `Changes in ${hash.slice(0, 7)}`;
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  }

  // ---- search --------------------------------------------------------------

  private async runSearch(query: string): Promise<void> {
    this.lastQuery = query;
    if (!query.trim()) {
      this.post({ type: 'search', query, hashes: [] });
      return;
    }
    this.searchIndex ??= getSearchIndex(this.repo, this.scope);
    try {
      const hashes = search(await this.searchIndex, query);
      if (query === this.lastQuery) this.post({ type: 'search', query, hashes });
    } catch (e) {
      this.searchIndex = undefined;
      this.post({ type: 'error', message: errorText(e) });
    }
  }

  // ---- html ----------------------------------------------------------------

  private html(): string {
    const webview = this.host.webview;
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
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
<link rel="stylesheet" href="${media('graph.css')}">
</head>
<body class="host-${this.host.kind}" data-layout='${JSON.stringify(this.context.globalState.get(this.layoutKey) ?? {})}' data-vscode-context='{"preventDefaultContextMenuItems": true}'>
  <div class="progress" id="progress"></div>
  <header class="toolbar">
    <div class="search" id="search-box">
      <i class="codicon codicon-search"></i>
      <input id="search" type="text" placeholder="Search message, author or SHA" spellcheck="false" aria-label="Search commits">
      <span class="count" id="search-count"></span>
      <button class="icon" id="search-prev" title="Previous match (Shift+Enter)" aria-label="Previous match"><i class="codicon codicon-arrow-up"></i></button>
      <button class="icon" id="search-next" title="Next match (Enter)" aria-label="Next match"><i class="codicon codicon-arrow-down"></i></button>
    </div>
    <div class="scope" role="radiogroup" aria-label="Branches shown">
      <button id="scope-all" role="radio" title="Show all branches, remotes and tags">All<span class="long"> branches</span></button>
      <button id="scope-current" role="radio" title="Show only the current branch's history">Current</button>
    </div>
    <span class="spacer"></span>
    <span class="status" id="status"></span>
    <button class="icon" id="go-head" title="Go to HEAD" aria-label="Go to HEAD"><i class="codicon codicon-target"></i></button>
    <button class="icon" id="fetch" title="Fetch all remotes" aria-label="Fetch"><i class="codicon codicon-cloud-download"></i></button>
    <button class="icon" id="refresh" title="Refresh" aria-label="Refresh"><i class="codicon codicon-refresh"></i></button>
  </header>
  <main class="main">
    <section class="list" id="list">
      <div class="row header">
        <div class="col-graph"></div>
        <div class="col-msg">Description</div>
        <div class="col-author">Author</div>
        <div class="col-date">Date</div>
        <div class="col-sha">Commit</div>
      </div>
      <div id="scroller" tabindex="0" role="listbox" aria-label="Commits">
        <div id="spacer"></div>
        <div id="rows"></div>
      </div>
      <div class="empty" id="empty" hidden></div>
    </section>
    <div class="resizer" id="resizer" hidden role="separator" aria-orientation="vertical"></div>
    <aside class="details" id="details" hidden></aside>
  </main>
  <script nonce="${nonce}" src="${media('graph.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    GraphController.all.delete(this);
    if (GraphController.active === this) GraphController.active = [...GraphController.all].at(-1);
    clearTimeout(this.reloadTimer);
    clearTimeout(this.wipTimer);
    this.repoDisposables.forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
