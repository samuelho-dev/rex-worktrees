# Rex Worktrees

Rex Worktrees opens Git worktrees or Jujutsu (JJ) workspaces in an exact [Rex](https://www.superlogical.com/rex/docs) session on this machine or an existing Rex host. Its keyboard-driven chooser runs in a floating Rex terminal. Rex manages hosts, connections, and sessions; this tool creates or selects a checkout and opens a shell there. When a selected logical project has no directory on the destination, the chooser can clone published history and open it there.

## Install

The standalone executable supports Apple Silicon Macs running macOS 15 or later. Git 2.42 or later, a running local Rex server, and the Rex CLI are required; JJ projects additionally require Jujutsu 0.46 or later. Node.js and npm are needed to install the npm package, but not to run the executable; Bun is not required.

### npm

```sh
npm install -g rex-worktrees
rex-worktrees setup --bin "$(npm root -g)/rex-worktrees/dist/rex-worktrees"
rex config reload
```

`--bin` registers the executable in the global npm package rather than copying it, so the path continues to work after package upgrades under the same npm global prefix. After an upgrade, repeat setup and `rex config reload` to update the Rex integration.

### GitHub Releases

Download the Apple Silicon binary archive from [GitHub Releases](https://github.com/samuelho-dev/rex-worktrees/releases) and extract it to a permanent location. Run setup with the absolute path to the extracted executable:

```sh
/absolute/path/to/rex-worktrees setup --bin /absolute/path/to/rex-worktrees
rex config reload
```

Keep the executable at that path when replacing it with a newer release, then repeat setup and `rex config reload`. Each application archive also contains the relinkable bundle and license notices described below.

### Build from source

Building requires Bun 1.3.13. From a source checkout, run:

```sh
bun install --frozen-lockfile
bun run build
./dist/rex-worktrees setup
rex config reload
```

Source-build setup copies the executable to `~/.local/bin/rex-worktrees`; `setup --bin PATH` instead registers an existing executable without copying or modifying it. Add `~/.local/bin` to `PATH` for source-build CLI use.

All installation methods place the Lua module beside the active Rex config and add a managed registration without replacing unrelated config. Setup needs `rex` on `PATH`, or `REX_BIN_DIR` set to its absolute directory. Setup from uncompiled source is not supported. Setup records **this host's executable search `PATH`** for stored Rex actions, whose server-side process may otherwise lack shell-installed tools; run setup from a shell that can find Git and, for JJ projects, `jj`, then `rex config reload`. Repeat setup and reload after changing the tools' search path. Each execution machine needs its own helper installation and, for JJ projects, its own JJ and Git installations; setup does not pair or deploy to another host. The source machine also needs the helper to inspect clone sources.

To update a source build, rebuild and repeat setup and config reload. To uninstall, locate the active Rex config with `rex config check --json`, remove the section from `-- BEGIN rex-worktrees` through `-- END rex-worktrees`, and delete `rex-worktrees.lua` beside that config. Remove the executable with `npm uninstall -g rex-worktrees`, or delete the standalone executable or `~/.local/bin/rex-worktrees` for other installations, then run `rex config reload`. Git worktrees, JJ workspaces, and association state are retained.

## Open a worktree

Choose **Open Worktree…** in the Rex palette or run:

```sh
rex do worktrees_open
```

No keyboard shortcut is installed by default. To add one, put an unused native binding outside the managed section of your Rex config:

```lua
rex.bind("ctrl+alt+w", "worktrees_open")
```

For a manual Lua installation, supply an absolute executable path with `require("rex-worktrees").setup({ bin = "/absolute/path/to/rex-worktrees" })`.

The chooser has six fields (five when opening an existing JJ workspace):

- **Project:** select a known Git or JJ project, type a project name, or enter an absolute repository path. Linked checkouts appear under their canonical project.
- **Machine:** select this machine or an existing Rex host. Changing machines keeps the logical project choice but clears host-bound checkout, base, clone destination, and session bindings; select or enter an actual project directory on the destination.
- **Worktree / Workspace:** Git shows worktrees; JJ shows all registered workspaces, including unavailable entries with an unknown/missing location (visible but not openable). Select an available checkout, type a name for a new checkout/workspace, or choose **Clone this project…** for a known logical project. A clone destination must be an editable absolute path on the destination machine; configured project roots offer suggestions. When cloning, typing a name here optionally creates a separate checkout/workspace; type `none` to use the clone's default.
- **Branch / Start from:** Git branches retain their existing behavior: attach an unoccupied branch or create a new branch from the reviewed base. For a new JJ workspace, **Start from** selects the repository-configured `trunk()` mainline when it resolves to one valid commit. If no valid mainline is available, choose a source candidate or type a singular revision before creating the workspace. A bookmark or revision selection overrides the default; the action pins its full commit ID. This field is hidden when opening a selected existing JJ workspace, which opens unchanged. A JJ clone can use the clone's native default without a pin, or select/type a source revision resolved on the actual source machine before cloning. Bookmarks are optional; this tool never creates one automatically. Source-only unpublished JJ changes and unpushed Git branches are not available in a destination clone.
- **Session:** choose an exact session on the selected machine.
- **Mode:** reuse a matching live tab, open another tab, or split a matching task. If a split has no matching task, it opens a new tab. Cloning always starts a new tab.

Use arrows or `j`/`k` to move, Tab/Shift+Tab to change fields, and Enter to edit or submit. In an editor, type to filter or create, use arrows for existing options, and Ctrl+U to clear. In the popup, Ctrl+S commits a valid selection or typed edit and submits the reviewed action when available; an invalid edit does not submit, and plain Enter still only selects. Esc cancels an edit or, from the form, closes the chooser. Project and checkout paths appear in the selection lists rather than as extra lines on the main form. Review the checkout path and action before submitting. A clone proposal displays its validated source URL and exact destination, and requires **Clone & Open** consent; merely changing machines never starts cloning. No agent or model is required; the task opens a shell.

## Projects and checkout locations

Configuration is optional and belongs on the **execution machine** at `${XDG_CONFIG_HOME:-~/.config}/rex-worktrees/config.json`:

```json
{
  "projects": [
    "/absolute/path/to/project",
    {
      "path": "/absolute/path/to/another-project",
      "worktreeRoot": "/absolute/path/to/another-project-checkouts"
    }
  ],
  "roots": ["/absolute/path/to/projects"],
  "worktreeRoot": "/absolute/path/to/checkouts"
}
```

`projects` explicitly registers paths; optional `roots` scans two directory levels for projects and offers destination-path suggestions when cloning. Without either, the originating Rex pane's directory (or the CLI caller's directory) can suggest its Git or JJ project, but no parent directory is scanned. A local directory suggestion is not sent to another machine: enter or select the project directory on that destination. A path typed in the form is interpreted there. Git and JJ, not configuration, determine their existing checkouts and branches/revisions. A missing directory for a known source project with a validated origin can be proposed for Clone & Open; an existing valid directory continues through ordinary open.

For a popup launched from a Rex pane on this machine, the chooser checks that exact pane's reported directory (a local OSC 7 `file://` URI or absolute path). If Rex has not reported one, it uses the same pane's foreground process `cwd` when available. A remote pane or foreign URI is never treated as a local path. Context can legitimately be absent if the pane has no usable local directory, or the directory is not inside a Git or JJ repository; select or enter a project in that case. `--no-context` explicitly disables origin discovery.

New checkout location follows this order: a project's `worktreeRoot/<name>`, the global `worktreeRoot/<primary-project-name>/<name>`, or, by default, a sibling `<main-checkout>.worktrees/<name>`. `~` refers to the destination user's home; relative configuration paths resolve against the config file's directory. Checkout locations must be outside existing checkouts and version-control metadata. Collisions and escaping paths are rejected rather than renamed. JJ's own `git.colocate` setting governs whether its workspace also has Git metadata; the helper does not emulate colocation.

## CLI

```sh
rex-worktrees popup
rex-worktrees launch-popup --session session:FULL-ID
rex-worktrees launch-popup --session session:FULL-ID --host workstation

rex-worktrees open --repo /absolute/path/project \
  --branch feature/name --worktree-name feature-task \
  --session session:FULL-ID --name Feature

rex-worktrees open --host workstation --repo /destination/path/project \
  --worktree /destination/path/existing-checkout \
  --session session:DESTINATION-ID --name Existing

rex-worktrees open --repo /absolute/path/jj-workspace \
  --revision 'main@origin' --worktree-name task \
  --session session:FULL-ID --name Task
```

`popup` runs the chooser in the invoking terminal; `launch-popup` opens its floating UI in the source Rex window. For `launch-popup` from an external terminal, supply `--session`; inside Rex, the originating session is available automatically. `launch-popup --host` keeps the UI on the caller's server while selecting another execution host. `--host` accepts an existing Rex host label or registry ID; find exact destination session IDs with `rex -S HOST ls --json`. Remote `--repo` and `--worktree` paths must be absolute paths on the destination.

`open` detects Git or JJ at `--repo`; no VCS switch is needed. Git accepts `--branch` or `--worktree`, with `--worktree-name` for a new branch checkout. JJ accepts `--worktree` for an existing workspace, or `--revision` plus `--worktree-name` for a new workspace. `--repo` is the actual invoking JJ workspace on the destination: relative revisions such as `@-` resolve there, and creating a new workspace may snapshot it. `--name` independently labels the tab or pane. By default, a matching live tab is reused; `--additional` opens another tab, and `--split` splits a matching task or falls back to a new tab. These two flags cannot be combined. `--client ID` selects an exact Rex app client when needed. See `rex-worktrees --help` for popup origin/context flags.

## Safety and limits

A submitted checkout or clone task can continue after the chooser closes, and closing a tab does not delete its checkout or clone. If a launch times out or Rex reports an uncertain result, inspect the destination repository and exact session before retrying; partial/registered JJ workspaces and clone destinations are retained rather than blindly removed or retried. Opening or browsing an existing JJ workspace does not snapshot, edit, update-stale, rebase, or move bookmarks. **Creating a JJ workspace invokes native `jj workspace add`, which may snapshot the actual source workspace and change its JJ working-copy commit and Git index intent-to-add entries**; the review notice names that source. Git worktrees keep their separate files, HEAD, and index while sharing refs, objects, remotes, and config. The tool does not force checkout, switch, stash, reset, clean, or prune. A cross-host clone transfers only published Git history from the source origin, not uncommitted files, local-only commits/branches/changes, source credentials, or environment. An explicitly pinned JJ base must be reachable after destination clone or the retained clone requires inspection; omitting a pin uses the clone's native default. Destination credentials and network access must work independently. Shells are not confined to the checkout. Associations live per destination at `${XDG_STATE_HOME:-~/.local/state}/rex-worktrees/associations`; Git/JJ inventory remains authoritative if an association becomes stale.

Local macOS execution is supported. Cross-host execution and cloning are experimental; Linux destinations have not been verified against a live remote Rex/JJ setup. Each execution machine requires a matching Rex Worktrees build (older helper protocols are rejected), its own Git/JJ executables as applicable, and a connected Rex host. Native app navigation requires Rex Remote Control permission. Local endpoints must be Unix endpoints; Windows named pipes are not supported. For a custom local Unix server, set `REX_WORKTREES_LOCAL_ENDPOINT=unix:///absolute/path/server.sock` in the plugin environment.

## Contributing

```sh
bun install
bun run check
bun run test
bun run build
```

## License and runtime sources

Project code is [MIT-licensed](LICENSE). The standalone executable embeds Bun; bundled components retain their upstream licenses, reproduced in [the third-party notices](licenses/THIRD-PARTY-NOTICES). Normal use requires no Bun installation or runtime source files.

<details>
<summary>Rebuilding with a modified runtime</summary>

Each application [release](https://github.com/samuelho-dev/rex-worktrees/releases) includes the relinkable `rex-worktrees.js` bundle, README, MIT license, and third-party notices in its binary archive. The matching Bun 1.3.13 runtime sources are available from the fixed [runtime-source release (v0.1.1)](https://github.com/samuelho-dev/rex-worktrees/releases/tag/v0.1.1): [Bun source](https://github.com/samuelho-dev/rex-worktrees/releases/download/v0.1.1/bun-1.3.13-source.tar.gz), [WebKit/JavaScriptCore source](https://github.com/samuelho-dev/rex-worktrees/releases/download/v0.1.1/bun-webkit-source.tar.gz), and [tinycc source](https://github.com/samuelho-dev/rex-worktrees/releases/download/v0.1.1/bun-tinycc-source.tar.gz). Each release's `SHA256SUMS` covers its own downloadable assets; use [v0.1.1 checksums](https://github.com/samuelho-dev/rex-worktrees/releases/download/v0.1.1/SHA256SUMS) for runtime sources.

Runtime source revisions are Bun 1.3.13 (`bf2e2cecf27e800962b1e7f03d66278f9d5d2e79`), WebKit (`4d5e75ebd84a14edbc7ae264245dcd77fe597c10`), and tinycc (`12882eee073cfe5c7621bcfadf679e1372d4537b`). Rebuilding requires the toolchain described in [Bun's contributing guide](https://github.com/oven-sh/bun/blob/bun-v1.3.13/CONTRIBUTING.md), including its LLVM requirements.

Extract the Bun source and matching library snapshots, make the desired library changes, then rebuild the runtime and application:

```sh
mkdir -p bun-source/vendor/WebKit bun-source/vendor/tinycc
tar -xzf bun-1.3.13-source.tar.gz -C bun-source --strip-components 1
tar -xzf bun-webkit-source.tar.gz -C bun-source/vendor/WebKit --strip-components 1
tar -xzf bun-tinycc-source.tar.gz -C bun-source/vendor/tinycc --strip-components 1
cd bun-source
bun install --frozen-lockfile
GIT_SHA=bf2e2cecf27e800962b1e7f03d66278f9d5d2e79 bun run build:release:local
./build/release-local/bun build /absolute/path/to/rex-worktrees.js \
  --compile --outfile /absolute/path/to/rex-worktrees-relinked
codesign --force --sign - /absolute/path/to/rex-worktrees-relinked
```

</details>
