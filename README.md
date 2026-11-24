# Commit Graph

Free git commit graph for VS Code, in the spirit of GitLens' graph.

## Features

- **Graph**: lanes coloured from your theme, merges, HEAD ring, dashed row for uncommitted changes
- **Labels**: branches, tags and remotes; a local branch in sync with its remote shows as one label with a cloud icon
- **Details**: click a commit to see its full message, author, parents and changed files with +/− counts
- **Diffs**: click a file for VS Code's diff view; the multi-diff icon (or Enter / double-click) opens every change
- **Compare two commits**: select one, Ctrl/Cmd+click another (or right-click → Compare with Selected) to list every file changed between them; click a file or press Enter for the diffs, Esc to exit
- **Right-click a commit**: checkout, create branch or tag, cherry-pick, merge, rebase, revert, reset, compare with working tree, open on GitHub/GitLab/Bitbucket, copy SHA or message
- **Right-click a label**: switch to it, merge, rebase onto it, rename, delete, copy name
- **Drag a branch label** onto another branch label to merge, rebase or fast-forward (dropping A on B: Merge A into B, Rebase B onto A); onto a commit to rebase the branch onto it or merge the commit in. A branch that isn't checked out is switched to first. Esc cancels; drag near the top or bottom edge to scroll. The same actions are in the right-click menus
- **Sync**: ↓ pull and ↑ push counts in the toolbar (hover to preview the commits; Publish when a branch has no upstream); unpushed ↑ and unpulled ↓ commits marked in the Commit column; branch labels show ↓1↑2 or ⚠ when the upstream was deleted
- **Highlight a branch**: hover a label to light its line down to where it forked from your branch; right-click → Highlight Branch Line (or select a commit and press L) to pin it; Esc or the chip clears it
- **Stashes**: each stash shows as a row just above the commit it was made on, with a hollow square and a muted `stash@{n}` label; click for its message and files (untracked too), right-click to apply, pop or drop. Stashes on commits hidden by scope or not loaded yet stay hidden until their base is shown
- **Search** (Ctrl+F): message, author, email or SHA, across all history; non-matches dim in place; Enter / Shift+Enter or F3 step through matches. Terms combine (all must match): `author:ada` or `author:"Ada L"`, `message:fix`, `file:src/git.ts` or `file:*.css`, `after:2026-01-01` / `before:2026-06-01` / `after:2w`, `type:merge` / `type:nonmerge`, `#abc123` or `sha:abc123`
- **Scrollbar markers**: like the editor's overview ruler: HEAD, selection, branch tips, uncommitted changes, unpushed ↑ / unpulled ↓ commits, search matches and the highlighted branch line, drawn under the scrollbar
- **Scope**: all branches, or the current branch only
- **Live**: refreshes on commits, checkouts, fetches and file saves; history loads 500 commits at a time
- **Keys**: ↑ ↓ PgUp PgDn Home End to move, P / Shift+P to go to first / second parent, C to the child on the same line, [ ] to the previous / next merge, H to HEAD, B to pick a branch or tag, Enter to open changes, Ctrl+C to copy SHA, Ctrl+click to compare, L to highlight the line, Esc to close details or clear the highlight, ? for the key list

## Where it lives

- **Panel tab**: "Commit Graph" sits next to Terminal. Open it with `Ctrl+Alt+G`, **Commit Graph: Show Commit Graph**, or the button in Source Control.
- **Right sidebar**: drag the tab into the secondary sidebar (View → Appearance → Secondary Side Bar). When narrow, details stack under the list.
- **Editor tab**: the "Open in Editor" button in the view's title bar, or **Commit Graph: Open Commit Graph in Editor**.
- **Multi-root workspaces**: the repo button in the view's title bar switches repository.

## Develop

- `npm test`: compile and run tests
- F5 in VS Code: run in an Extension Development Host
- `npm run package && code --install-extension commit-graph-0.1.0.vsix`: install

## Layout

- `src/git.ts`: every git call and parser
- `src/lanes.ts`: lane layout algorithm (pure, unit tested)
- `src/search.ts`: search query parser (pure, unit tested)
- `src/controller.ts`: drives one graph webview: paging, live refresh, search, details, diffs
- `src/hosts.ts`: editor tab and panel/sidebar view hosts
- `src/repos.ts`: picks which repository to show
- `src/actions.ts`: right-click menu actions
- `src/drop.ts`: drag-and-drop menu: which merge / rebase / fast-forward to offer (pure, unit tested)
- `src/content.ts`: read-only "file at revision" documents for diffs
- `media/graph.js`, `media/graph.css`: webview UI
