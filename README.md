# Rex Worktrees

A keyboard-driven [Rex](https://www.superlogical.com/rex/docs) plugin for opening and creating **Git worktrees** and **Jujutsu (JJ) workspaces**. Pick a project, machine, session, and worktree; it opens a shell there. No agent or model required.

<img width="693" height="236" alt="image" src="https://github.com/user-attachments/assets/fadd8e3c-30fc-4f94-98ca-41132a23ff36" />

## Install

Requires Rex and its CLI, a running Rex server, and Git 2.42+. JJ projects also need Jujutsu 0.46+. Standalone builds support Apple Silicon macOS 15+ and Linux x64; no Bun runtime is needed.

**Install or update on macOS (Apple Silicon):**

```sh
npm install -g rex-worktrees
rex-worktrees setup
rex config reload
```

npm installs the CLI; `setup` registers the Lua plugin with Rex and copies its executable to `~/.local/bin/rex-worktrees` for the plugin to use. No executable path is needed. Run setup from a shell that can find `rex`, `git`, and optionally `jj`; unrelated Rex settings are preserved. Repeat all three commands to update.

**Without npm / Linux:** download your platform's archive from [GitHub Releases](https://github.com/samuelho-dev/rex-worktrees/releases/latest), verify it against `SHA256SUMS`, and extract it. From the extracted directory:

```sh
./rex-worktrees setup && rex config reload
```

Setup copies the executable to the same stable location, so the extracted directory is not needed afterward. `setup --bin /absolute/path/to/rex-worktrees` is only for keeping an executable at a custom or package-managed location.

## Use

Open **Open Worktree…** from the Rex palette, or run:

```sh
rex do worktrees_open
```

The popup detects the source terminal's project, current worktree, branch or revision, and full directory path. Git worktrees are separate checkout directories sharing one repository—not separate repositories or branch names.

1. **Project:** select a discovered project or type an absolute repository path.
2. **Machine:** choose this machine or an existing Rex host.
3. **Session:** select an existing session, or type a name to create one.
4. **Worktree / Workspace:** select an existing one, or choose **Create new worktree… / Create new workspace…**. This list contains worktrees, not branches or clone actions.
5. **Branch:** **Create new worktree…** opens the branch editor directly, without another click on the form. Select an unused existing branch or type a new branch name. JJ uses **Start from** instead; a valid `trunk()` is selected automatically.
6. **Directory:** new worktrees get a proposed absolute path; change it only if needed. A new JJ workspace takes its name from the directory's final component.
7. Choose **Open worktree / Create worktree & open**, or press **Ctrl+S** from the form. Accepting a field only updates the form; creation happens on submission.

**Mode** reuses a matching tab by default; choose a new tab or split instead.

For an **existing worktree**, Branch (or Revision) and Directory describe the detected checkout. They remain readable and **read-only—not disabled**; Tab skips them. Select a different worktree to open another checkout. For a **new worktree**, Branch and Directory are editable.

The underlined `REX / WORKTREES` header, fields, and footer keep fixed positions. Editors and messages reuse the same details area, so only choice lists and long details scroll.

Shells and interactive Git/JJ clones stay attached to the destination terminal. The shell comes from `$SHELL`, falling back to `/bin/sh`.

Rex owns terminal placement, focus, and popup cleanup. New sessions and their first terminal are created together; checkout/clone work then runs in that terminal independently of the chooser.
Connection and review snapshots are operation-local: new sessions and forced new tabs skip reuse scans, and submission still checks fresh host and checkout state.

| Key | Action |
| --- | --- |
| Tab / Shift+Tab | Move between fields and buttons |
| ↑ / ↓ | Navigate fields or choices |
| Enter | Edit a field, accept its value, or activate a focused button |
| Ctrl+S | Submit the form; inside an editor, only accept that field |
| Esc | Return from an editor to the form; from the form, close the popup |
| PageUp / PageDown | Scroll long details |

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

Install and run setup on each execution machine, with matching plugin versions and local Git/JJ tools. Connect the host through Rex first. Paths and configuration belong to the selected machine. This native-integration update uses helper protocol v5; update all execution machines together.

If the selected machine lacks the project, the form proposes cloning it and shows the repository destination explicitly. **Directory** edits that path, and submission becomes **Clone & open**. Changing a field never starts a clone. The Worktree picker can also create a separate worktree after cloning; Directory then controls that worktree's path. Cloning opens a new tab. Only pushed history transfers—not uncommitted work, unpublished changes, or credentials. Cross-host execution and cloning are experimental; live remote Linux destinations have not been verified.

## Safety

- Existing checkouts open unchanged. The plugin never switches, resets, stashes, cleans, or deletes an existing checkout.
- **Creating a JJ workspace runs `jj workspace add`, which may snapshot its source workspace.**
- Closing the chooser or a tab does not delete a checkout or stop an already-submitted task.
- If a launch times out or says **needs inspection**, inspect the destination and session before retrying; a task may already exist.

## CLI and development

Run `rex-worktrees --help` for direct `open` commands and host/session options. `rex-worktrees popup` runs the chooser in the current terminal.

Build from source with Bun 1.3.13:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
./dist/rex-worktrees setup
rex config reload
```

Source-build setup installs to `~/.local/bin/rex-worktrees`. To uninstall, remove the `BEGIN rex-worktrees` / `END rex-worktrees` section and adjacent `rex-worktrees.lua` from your active Rex config (`rex config check --json`), remove the executable, and reload. Repositories are retained.

Releases publish the tested macOS archive to npm through GitHub Actions OIDC, then verify registry version and tarball integrity. The npm trusted publisher must authorize `samuelho-dev/rex-worktrees`, workflow `release.yml`, for direct publishing; no npm token is used. Tag a matching package version (`vX.Y.Z`) to release.

Registry verification allows up to 120 checks, ten seconds apart, for npm processing. Publishing is not retried; an integrity mismatch still fails the release.

## License

[MIT](LICENSE). Standalone builds embed Bun; see [third-party notices](licenses/THIRD-PARTY-NOTICES).

<details>
<summary>Runtime sources and rebuilding</summary>

Release archives include the relinkable `rex-worktrees.js` bundle. Matching Bun 1.3.13, WebKit, and tinycc sources and checksums are in the [runtime-source release](https://github.com/samuelho-dev/rex-worktrees/releases/tag/v0.1.1). Extract all three source archives, placing WebKit at `bun-source/vendor/WebKit` and tinycc at `bun-source/vendor/tinycc` (strip each archive's top-level directory).

Follow [Bun's build prerequisites](https://github.com/oven-sh/bun/blob/bun-1.3.13/CONTRIBUTING.md), then run in `bun-source`:

```sh
bun install --frozen-lockfile
GIT_SHA=bf2e2cecf27e800962b1e7f03d66278f9d5d2e79 bun run build:release:local
./build/release-local/bun build /absolute/path/to/rex-worktrees.js --compile --outfile /absolute/path/to/rex-worktrees-relinked
codesign --force --sign - /absolute/path/to/rex-worktrees-relinked # macOS only
```

</details>
