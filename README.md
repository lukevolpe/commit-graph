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
- **Pull requests**: right-click a branch label → Create Pull Request… opens the GitHub, GitLab or Bitbucket compare page against the remote's default branch; an unpublished or unpushed branch is offered a push first. No sign-in, just the browser
- **Force push**: when a push is rejected because the remote moved on, offers Force Push (with lease), which still refuses if the remote changed since your last fetch
- **Remote refs**: right-click a tag → Push Tag or Delete Tag on Remote; right-click a remote branch → Fetch Remote (just that remote) or Delete Remote Branch
- **Remotes**: **Commit Graph: Manage Remotes** (also in the view's `…` menu) lists remotes with their URLs; add, rename, remove, fetch or prune one
- **Highlight a branch**: hover a label to light its line down to where it forked from your branch; right-click → Highlight Branch Line (or select a commit and press L) to pin it; Esc or the chip clears it
- **Stashes**: each stash shows as a row just above the commit it was made on, with a hollow square and a muted `stash@{n}` label; click for its message and files (untracked too), right-click to apply, pop or drop. Stashes on commits hidden by scope or not loaded yet stay hidden until their base is shown
- **Stash changes**: right-click the uncommitted-changes row (or the view's ⋯ menu) → Stash Changes…: tracked only, including untracked, or staged only (git 2.35+), with an optional message
- **Undo** (Ctrl+Z or the ↶ title button): undoes the last commit, amend, merge, rebase, pull, cherry-pick, revert, reset or checkout from the reflog, after a confirm saying where the branch goes back to. Uses `reset --keep`, so uncommitted changes are kept (it refuses if they'd be overwritten); warns before dropping commits already pushed
- **Worktrees**: a branch checked out in another worktree gets a worktree icon (hover for its folder); a detached worktree shows a muted label on its commit. Right-click a branch → Create Worktree… (defaults to a `<repo>-<branch>` folder next to the repo; remote branches get a local tracking branch), then open it in a new window or add it to the workspace. Right-click a branch in another worktree → Open Worktree or Remove Worktree… (asks again before deleting uncommitted changes). Switching to such a branch offers to open its worktree instead. **Commit Graph: Worktrees…** (view title `…` menu or Command Palette) lists them to open, add, remove or prune
- **Search** (Ctrl+F): message, author, email or SHA, across all history; non-matches dim in place; Enter / Shift+Enter or F3 step through matches. Terms combine (all must match): `author:ada` or `author:"Ada L"`, `message:fix`, `file:src/git.ts` or `file:*.css`, `after:2026-01-01` / `before:2026-06-01` / `after:2w`, `type:merge` / `type:nonmerge`, `#abc123` or `sha:abc123`
- **Scrollbar markers**: like the editor's overview ruler: HEAD, selection, branch tips, uncommitted changes, unpushed ↑ / unpulled ↓ commits, search matches and the highlighted branch line, drawn under the scrollbar
- **Merge / rebase in progress**: a banner under the toolbar shows what's happening ("Merging feature/x into main · 3 conflicts", "Rebasing step 2 of 5"), lists conflicted files (click to open; VS Code's merge editor takes over) and offers Continue, Skip and Abort. Also covers cherry-pick, revert and bisect (Good / Bad / End). Updates live as you resolve
- **Git flow**: **Commit Graph: Git Flow…** (palette or the view's ⋯ menu) starts or finishes feature, release and hotfix branches with plain git, no git-flow install needed. Honours `gitflow.branch.*` and `gitflow.prefix.*` config; finishing merges `--no-ff`, tags releases and hotfixes, and optionally deletes the branch
- **Scope**: all branches, or the current branch only
- **File history**: right-click a file (explorer, editor tab or editor) → Show File History in Commit Graph, or run it from the palette for the active editor. The graph keeps its lanes but shows only commits touching that file (or folder), with the file marked in each commit's file list; the History chip or Esc returns to the full graph. Doesn't follow renames: history stops where the file got its current name
- **Line history**: right-click in the editor → Show Line History in Commit Graph for the current line or selection; commits that changed those lines stay lit, the rest dim, the newest is selected. Reveal Commit in Graph jumps to the commit that last changed the current line (blame). Lines are as of the saved file at HEAD
- **Live**: refreshes on commits, checkouts, fetches and file saves; history loads 500 commits at a time
- **Keys**: ↑ ↓ PgUp PgDn Home End to move, P / Shift+P to go to first / second parent, C to the child on the same line, [ ] to the previous / next merge, H to HEAD, B to pick a branch or tag, Enter to open changes, Ctrl+C to copy SHA, Ctrl+click to compare, L to highlight the line, Ctrl+Z to undo the last action, Esc to close details or clear the highlight, ? for the key list

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
- `src/undo.ts`: reflog-based undo: classifies the last action (pure, unit tested) and plans how to reverse it
- `src/worktrees.ts`: `git worktree list` parser and worktree path helpers
- `src/gitflow.ts`: git-flow command planner (pure, unit tested)
- `src/controller.ts`: drives one graph webview: paging, live refresh, search, details, diffs
- `src/hosts.ts`: editor tab and panel/sidebar view hosts
- `src/repos.ts`: picks which repository to show
- `src/actions.ts`: right-click menu actions
- `src/drop.ts`: drag-and-drop menu: which merge / rebase / fast-forward to offer (pure, unit tested)
- `src/remotes.ts`: remotes, default branch, pull request URLs (unit tested)
- `src/history.ts`: file history, line history and blame commands from the editor and explorer
- `src/content.ts`: read-only "file at revision" documents for diffs
- `media/graph.js`, `media/graph.css`: webview UI
