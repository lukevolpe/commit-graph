import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  Commit,
  FileChange,
  Scope,
  SearchEntry,
  Stash,
  SyncState,
  getChanges,
  getDetails,
  getFileMatches,
  getHead,
  getLog,
  getSearchIndex,
  getStashDetails,
  getStashes,
  getSync,
  getWorkingChanges,
  git,
  gitDirs,
  insertStashes,
  search,
} from './git';
import { GraphLayout, GraphRow } from './lanes';
import { revisionUri } from './content';
import { SEARCH_HELP, parseQuery } from './search';

const PAGE = 500;
/** Hash used for the uncommitted-changes row. */
export const WIP = 'WORKING_TREE';

type InMessage =
  | { type: 'ready'; history?: string | null }
  | { type: 'refresh' }
  | { type: 'loadMore' }
  | { type: 'loadUntil'; hash: string }
  | { type: 'select'; hash: string }
  | { type: 'openDiff'; hash: string; parent: string | null; file: FileChange }
  | { type: 'openAll'; hash: string; parent: string | null; files: FileChange[] }
  | { type: 'openFile'; path: string }
  | { type: 'compare'; from: string; to: string }
  | { type: 'openCompareDiff'; from: string; to: string; file: FileChange }
  | { type: 'openCompareAll'; from: string; to: string; files: FileChange[] }
  | { type: 'search'; query: string }
  | { type: 'setScope'; scope: Scope }
  | { type: 'fetch' }
  | { type: 'pull' }
  | { type: 'push' }
  | { type: 'copy'; text: string; label: string }
  | { type: 'pickRef' }
  | { type: 'layout'; width: number; height: number }
  | { type: 'setHistory'; file: string | null };

type Row = Commit & { graph: GraphRow; wip?: boolean; stash?: string };

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
  private _sync: SyncState | null = null;
  /** Shown above their base commit once it's loaded; not part of `commits` (which drives paging). */
  private stashes: Stash[] = [];
  private done = false;
  private scope: Scope;
  /** File history mode: repo-relative path the graph is limited to. */
  private file: string | undefined;
  /** Resolves once the webview has said 'ready': messages posted before then are lost. */
  private markReady!: () => void;
  private readonly whenReady = new Promise<void>((r) => (this.markReady = r));
  private searchIndex: Promise<SearchEntry[]> | undefined;
  /** `file:` pattern → matching commits; dropped with the search index. */
  private fileMatches = new Map<string, Promise<Set<string>>>();
  private lastQuery = '';
  private detailsSeq = 0;
  private compareSeq = 0;
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

  /** Ahead/behind state as of the last reload. */
  get sync(): SyncState | null {
    return this._sync;
  }

  /** Points this graph at another repository. */
  setRepo(repo: string): void {
    if (repo === this._repo) return;
    this._repo = repo;
    this.repoDisposables.forEach((d) => d.dispose());
    this.repoDisposables = [];
    this.lastQuery = '';
    this.file = undefined;
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
    // Dropping an older stash only rewrites the stash reflog, not refs/stash.
    w(dirs.commonDir, 'logs/refs/stash', reload);
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
        // Restored from webview state; a history opened before the webview was ready wins.
        if (msg.history && !this.file) this.file = msg.history;
        void this.enqueue(() => this.reload(false));
        this.markReady();
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
      case 'compare':
        void this.sendCompare(msg.from, msg.to);
        break;
      case 'openCompareDiff':
        void this.openCompareDiff(msg.from, msg.to, msg.file);
        break;
      case 'openCompareAll':
        void this.openCompareAll(msg.from, msg.to, msg.files);
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
      case 'pull':
      case 'push':
        void vscode.commands.executeCommand(`commitGraph.${msg.type}`);
        break;
      case 'layout':
        void this.context.globalState.update(this.layoutKey, { width: msg.width, height: msg.height });
        break;
      case 'copy':
        void vscode.env.clipboard.writeText(msg.text);
        void vscode.window.setStatusBarMessage(`$(check) Copied ${msg.label}`, 2000);
        break;
      case 'pickRef':
        void this.pickRef().catch((e) => vscode.window.showErrorMessage(errorText(e)));
        break;
      case 'setHistory':
        this.showFileHistory(msg.file ?? undefined);
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
    this.fileMatches.clear();
    this.head = await getHead(this.repo);
    this.wipCount = this.head ? (await getWorkingChanges(this.repo)).length : 0;
    // Sync markers are a nicety: never let them break loading the graph.
    this._sync = await getSync(this.repo).catch(() => null);
    this.stashes = await getStashes(this.repo).catch(() => []);
    this.commits = await getLog(this.repo, this.scope, 0, count, this.file);
    this.done = this.commits.length < count;
    this.layout = new GraphLayout();
    const rows = this.toRows(this.commits, true);
    this.post({
      type: 'rows',
      mode: 'reset',
      keep,
      rows,
      done: this.done,
      head: this.head,
      scope: this.scope,
      sync: this._sync,
      history: this.file ?? null,
    });
    if (this.lastQuery) await this.runSearch(this.lastQuery);
  }

  private async loadMore(): Promise<Row[]> {
    if (this.done) return [];
    const page = await getLog(this.repo, this.scope, this.commits.length, PAGE, this.file);
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
    // File history: no uncommitted row or stashes; their base often isn't shown.
    const batch: (Commit & { wip?: boolean; stash?: string })[] = insertStashes(commits, this.file ? [] : this.stashes);
    if (first && this.wipCount && this.head && !this.file) batch.unshift(this.wipCommit());
    const graph = this.layout.add(batch.map((c) => (c.stash ? { ...c, side: true } : c)));
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

  /** B key: quick pick of branch and tag tips; the webview reveals the pick. */
  private async pickRef(): Promise<void> {
    const fmt = ['%(HEAD)', '%(refname)', '%(objectname)', '%(*objectname)', '%(contents:subject)'].join('%00');
    const out = await git(this.repo, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
    type Item = vscode.QuickPickItem & { hash?: string };
    const groups: Record<string, Item[]> = { Branches: [], Remotes: [], Tags: [] };
    for (const line of out.split('\n')) {
      const [head, full, obj, peeled, subject] = line.split('\0');
      if (!full || full.endsWith('/HEAD')) continue;
      const hash = peeled || obj;
      const [group, name, icon] = full.startsWith('refs/heads/')
        ? ['Branches', full.slice(11), head === '*' ? 'check' : 'git-branch']
        : full.startsWith('refs/remotes/')
          ? ['Remotes', full.slice(13), 'cloud']
          : ['Tags', full.slice(10), 'tag'];
      const item: Item = { label: `$(${icon}) ${name}`, description: `${hash.slice(0, 7)}  ${subject ?? ''}`, hash };
      if (head === '*') groups[group].unshift(item);
      else groups[group].push(item);
    }
    const items: Item[] = [];
    for (const [label, list] of Object.entries(groups)) {
      if (list.length) items.push({ label, kind: vscode.QuickPickItemKind.Separator }, ...list);
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Go to branch or tag', matchOnDescription: true });
    if (pick?.hash) this.post({ type: 'jumpTo', hash: pick.hash });
  }

  // ---- details & diffs -----------------------------------------------------

  private async sendDetails(hash: string): Promise<void> {
    const seq = ++this.detailsSeq;
    try {
      const details =
        hash === WIP
          ? { hash: WIP, wip: true, parents: this.head ? [this.head] : [], files: await getWorkingChanges(this.repo) }
          : this.stashes.some((s) => s.hash === hash)
            ? await getStashDetails(this.repo, hash)
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
    else if (f.untracked) right = revisionUri(this.repo, f.path, `${hash}^3`); // stash's untracked files
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

  // ---- compare two commits -------------------------------------------------
  // `from` is the older side, `to` the newer; `to` may be WIP (the working tree).

  private async sendCompare(from: string, to: string): Promise<void> {
    const seq = ++this.compareSeq;
    try {
      const files = await getChanges(this.repo, from, to === WIP ? undefined : to);
      if (seq === this.compareSeq) this.post({ type: 'compare', from, to, files });
    } catch (e) {
      if (seq === this.compareSeq) this.post({ type: 'compare', from, to, error: errorText(e) });
    }
  }

  private compareLabel(from: string, to: string): string {
    return `${from.slice(0, 7)} ↔ ${to === WIP ? 'Working Tree' : to.slice(0, 7)}`;
  }

  private async openCompareDiff(from: string, to: string, f: FileChange): Promise<void> {
    const [left, right] = this.diffSides(to, from, f);
    const name = path.posix.basename(f.path);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${this.compareLabel(from, to)})`, {
      preview: true,
    });
  }

  private async openCompareAll(from: string, to: string, files: FileChange[]): Promise<void> {
    const resources = files.map((f) => {
      const [left, right] = this.diffSides(to, from, f);
      return [vscode.Uri.file(path.join(this.repo, f.path)), left, right];
    });
    await vscode.commands.executeCommand('vscode.changes', this.compareLabel(from, to), resources);
  }

  // ---- search --------------------------------------------------------------

  private async runSearch(query: string): Promise<void> {
    this.lastQuery = query;
    if (!query.trim()) {
      this.post({ type: 'search', query, hashes: [] });
      return;
    }
    this.searchIndex ??= getSearchIndex(this.repo, this.scope, this.file);
    try {
      const q = parseQuery(query);
      const files = q.files.length ? await this.matchFiles(q.files) : undefined;
      const hashes = search(await this.searchIndex, q, files);
      // terms: what the webview highlights in subjects.
      if (query === this.lastQuery) this.post({ type: 'search', query, hashes, terms: [...q.text, ...q.message] });
    } catch (e) {
      this.searchIndex = undefined;
      this.fileMatches.clear();
      this.post({ type: 'error', message: errorText(e) });
    }
  }

  /** Commits touching every pattern (AND). */
  private async matchFiles(patterns: string[]): Promise<Set<string>> {
    const sets = await Promise.all(
      patterns.map((p) => {
        let m = this.fileMatches.get(p);
        if (!m) this.fileMatches.set(p, (m = getFileMatches(this.repo, this.scope, p)));
        return m;
      }),
    );
    const [first, ...rest] = sets;
    return new Set([...first].filter((h) => rest.every((s) => s.has(h))));
  }

  // ---- file & line history ------------------------------------------------

  /** Limits the graph to commits touching `file` (repo-relative); undefined for the full graph. */
  showFileHistory(file: string | undefined): void {
    if (file === this.file) return;
    this.file = file;
    void this.enqueue(() => this.withBusy('Loading', () => this.reload(false)));
  }

  /** Dims all but `hashes` (newest first) under a chip and selects the newest; after any pending load. */
  showLineMarks(label: string, hashes: string[]): void {
    void this.whenReady.then(() => this.enqueue(async () => this.post({ type: 'lineMarks', label, hashes })));
  }

  /** Selects a commit, loading history until it's there; after any pending load. */
  revealCommit(hash: string): void {
    void this.whenReady.then(() => this.enqueue(async () => this.post({ type: 'jumpTo', hash })));
  }

  get historyFile(): string | undefined {
    return this.file;
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
      <input id="search" type="text" placeholder="Search… (author: file: after:)" title="${SEARCH_HELP.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" spellcheck="false" aria-label="Search commits">
      <span class="count" id="search-count"></span>
      <button class="icon" id="search-prev" title="Previous match (Shift+Enter)" aria-label="Previous match"><i class="codicon codicon-arrow-up"></i></button>
      <button class="icon" id="search-next" title="Next match (Enter)" aria-label="Next match"><i class="codicon codicon-arrow-down"></i></button>
    </div>
    <div class="scope" role="radiogroup" aria-label="Branches shown">
      <button id="scope-all" role="radio" title="Show all branches, remotes and tags">All<span class="long"> branches</span></button>
      <button id="scope-current" role="radio" title="Show only the current branch's history">Current</button>
    </div>
    <div class="sync" id="sync"></div>
    <span class="spacer"></span>
    <button class="focus-chip" id="focus-chip" hidden title="Clear highlight (Esc)"></button>
    <button class="focus-chip" id="lines-chip" hidden title="Clear line history (Esc)"></button>
    <button class="focus-chip" id="history-chip" hidden title="Back to the full graph (Esc)"></button>
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
