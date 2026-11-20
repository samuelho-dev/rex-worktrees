# Rex Worktrees

A keyboard-driven [Rex](https://www.superlogical.com/rex/docs) plugin for opening and creating **Git worktrees** and **Jujutsu (JJ) workspaces**. Pick a project, machine, session, and worktree; it opens a shell there. No agent or model required.

## Install

Requires Rex API 17 or newer, its CLI, a running Rex server, and Git 2.42+. JJ projects also need Jujutsu 0.46+. The native picker requires the standalone executable backend on each execution machine. Builds support Apple Silicon macOS 15+ and Linux x64; no separately installed Lua runtime is needed.

On either platform, download its archive from [GitHub Releases](https://github.com/samuelho-dev/rex-worktrees/releases/latest), verify it against `SHA256SUMS`, and extract it. From the extracted directory, with `rex`, `git`, and optionally `jj` on your PATH:

```sh
./rex-worktrees setup && rex config reload
```

Setup installs the executable to a stable location and registers the Lua plugin with Rex, preserving unrelated Rex settings. The extracted directory is not needed afterward. Repeat these steps to update. `setup --bin /absolute/path/to/rex-worktrees` is for keeping an executable at a custom or package-managed location.

## Use

Open **Open Worktree…** from the Rex palette, or run:

```sh
rex do worktrees_open
```

The native summary picker detects the source terminal's project, current worktree, branch or revision, and full directory path. Select a field to edit it, then return to the summary. Escape returns from an editor or confirmation to the summary; Escape at the summary cancels without checkout changes. Git worktrees are separate checkout directories sharing one repository—not separate repositories or branch names.

1. **Project:** select a discovered project or type an absolute repository path.
2. **Machine:** choose this machine or an existing Rex host.
3. **Session:** select an existing session, or type a name to create one.
4. **Worktree / Workspace:** select an existing one, or choose **Create new worktree… / Create new workspace…**. This list contains worktrees, not branches or clone actions.
5. **Branch:** **Create new worktree…** opens the branch editor directly. Select an unused existing branch or type a new branch name. JJ uses **Start from** instead; a valid `trunk()` is selected automatically.
6. **Directory:** new worktrees get a proposed absolute path; change it only if needed. A new JJ workspace takes its name from the directory's final component.
7. Choose **Open worktree / Create worktree & open** in the summary. Editing fields only updates the draft; creation happens on submission. Safety warnings may require confirmation.

**Mode** reuses a matching tab by default; choose a new tab or split instead.

For an **existing worktree**, Branch (or Revision) and Directory describe the detected checkout and are read-only. Select a different worktree to open another checkout. For a **new worktree**, Branch and Directory are editable.

Shells and interactive Git/JJ clones stay attached to the destination terminal. The shell comes from `$SHELL`, falling back to `/bin/sh`.

Rex owns terminal placement and focus. New sessions and their first terminal are created together; checkout/clone work then runs in that terminal independently of the chooser. Submission checks fresh host and checkout state.

Optional shortcut—add outside the managed section of your Rex config, then reload:

```lua
rex.bind("ctrl+alt+w", "worktrees_open")
```

### Add projects

Without configuration, the current pane's repository is suggested. To list more projects, edit the existing registration in your Rex `init.lua`, then run `rex config reload`:

```lua
require("rex-worktrees").setup({
  projects = { "/absolute/path/to/project" },
  roots = { "/absolute/path/to/projects" },
})
```

Both settings are optional. `projects` lists repositories explicitly; `roots` discovers them up to two directory levels deep. New checkouts default to a sibling `<repository>.worktrees/<name>` directory. Set `worktreeRoot` globally or on a project object (`{ path = "…", worktreeRoot = "…" }`) to override it. Setup preserves these settings on upgrades and migrates the former JSON configuration.

### Other machines

Install and run setup on each execution machine, with matching plugin versions and local Git/JJ tools. Connect the host through Rex first. Paths and configuration belong to the selected machine. The helper protocol is v5; when a protocol upgrade requires it, upgrade both execution machines together.

If the selected machine lacks the project, the picker proposes cloning it and shows the repository destination explicitly. **Directory** edits that path, and submission becomes **Clone & open**. Changing a field never starts a clone. The Worktree picker can also create a separate worktree after cloning; Directory then controls that worktree's path. Cloning opens a new tab. Only pushed history transfers—not uncommitted work, unpublished changes, or credentials. Cross-host execution and cloning are experimental; live remote Linux destinations have not been verified.

## Safety

- Existing checkouts open unchanged. The plugin never switches, resets, stashes, cleans, or deletes an existing checkout.
- **Creating a JJ workspace runs `jj workspace add`, which may snapshot its source workspace.**
- Closing the chooser or a tab does not delete a checkout or stop an already-submitted task.
- If a launch times out or says **needs inspection**, inspect the destination and session before retrying; a task may already exist.

## CLI and development

Run `rex-worktrees --help` for direct `open` commands and host/session options.

Source builds require a C compiler, make, curl, tar, a SHA-256 utility, and network access to download pinned dependencies. Lua and native modules are built locally; an installed Lua is not required.
Regression tests also require Git, JJ, and Python 3.

```sh
make check
make test
make build
./dist/rex-worktrees setup
rex config reload
```

Source-build setup installs to `~/.local/bin/rex-worktrees`. To uninstall, remove the `BEGIN rex-worktrees` / `END rex-worktrees` section and adjacent `rex-worktrees.lua` from your active Rex config (`rex config check --json`), remove the executable, and reload. Repositories are retained.

Releases publish both tested platform archives and `SHA256SUMS` to GitHub. A Git version tag (`vX.Y.Z`) is the release authority.

## License

[MIT](LICENSE)
