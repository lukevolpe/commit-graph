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
- **Sync**: ↓ pull and ↑ push counts in the toolbar (hover to preview the commits; Publish when a branch has no upstream); unpushed ↑ and unpulled ↓ commits marked in the Commit column; branch labels show ↓1↑2 or ⚠ when the upstream was deleted
- **Highlight a branch**: hover a label to light its line down to where it forked from your branch; right-click → Highlight Branch Line (or select a commit and press L) to pin it; Esc or the chip clears it
- **Search** (Ctrl+F): message, author, email or SHA, across all history; Enter / Shift+Enter or F3 step through matches
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
- `src/controller.ts`: drives one graph webview: paging, live refresh, search, details, diffs
- `src/hosts.ts`: editor tab and panel/sidebar view hosts
- `src/repos.ts`: picks which repository to show
- `src/actions.ts`: right-click menu actions
- `src/content.ts`: read-only "file at revision" documents for diffs
- `media/graph.js`, `media/graph.css`: webview UI
