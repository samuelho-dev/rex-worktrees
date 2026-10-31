# Rex Worktrees

Rex Worktrees opens Git worktrees in an exact [Rex](https://www.superlogical.com/rex/docs) session on this machine or an existing Rex host. Its keyboard-driven chooser runs in a floating Rex terminal. Rex manages hosts, connections, and sessions; this tool creates or selects a checkout and opens a shell there.

## Install

The standalone release requires Git and a running local Rex server with the Rex CLI available. **Bun is not required to run it.** Prebuilt binaries support Apple Silicon Macs running macOS 15 or later.

### Homebrew

```sh
brew install samuelho-dev/tap/rex-worktrees
"$(brew --prefix rex-worktrees)/bin/rex-worktrees" setup \
  --bin "$(brew --prefix rex-worktrees)/bin/rex-worktrees"
rex config reload
```

The registration uses Homebrew's stable `opt` path, so Rex follows package upgrades rather than using a copied executable. After `brew upgrade`, repeat setup and config reload.

### Build from source

Building requires Bun 1.3.13. From a source checkout, run:

```sh
bun install --frozen-lockfile
bun run build
./dist/rex-worktrees setup
rex config reload
```

Source-build setup copies the executable to `~/.local/bin/rex-worktrees`; `setup --bin PATH` instead registers an existing package-managed executable without copying or modifying it. Add `~/.local/bin` to `PATH` for source-build CLI use.

Both modes install the Lua module beside the active Rex config and add a managed registration without replacing unrelated config. Setup needs `rex` on `PATH`, or `REX_BIN_DIR` set to its absolute directory. Setup from uncompiled source is not supported. Each execution machine needs its own installation; setup does not pair or deploy to another host.

To update a source build, rebuild and repeat setup and config reload. To uninstall, locate the active Rex config with `rex config check --json`, remove the section from `-- BEGIN rex-worktrees` through `-- END rex-worktrees`, and delete `rex-worktrees.lua` beside that config. Remove the executable with `brew uninstall rex-worktrees`, or delete `~/.local/bin/rex-worktrees` for a source installation, then run `rex config reload`. Git worktrees and association state are retained.

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

The chooser has six fields:

- **Project:** select a known Git project, type a project name, or enter an absolute repository path. Linked checkouts appear under their canonical project.
- **Machine:** select this machine or an existing Rex host. Changing machines keeps the logical project choice but clears checkout, branch, and session bindings; select or enter the actual project directory on the destination.
- **Worktree:** select a checkout reported by Git or type a name for a new checkout directory. Its directory name need not match the branch name.
- **Branch:** select or type a branch. An existing branch without a checkout is attached; one already checked out resolves to that checkout. A new branch starts from the reviewed base commit.
- **Session:** choose an exact session on the selected machine.
- **Mode:** reuse a matching live tab, open another tab, or split a matching task. If a split has no matching task, it opens a new tab.

Use arrows or `j`/`k` to move, Tab/Shift+Tab to change fields, and Enter to edit or submit. In an editor, type to filter or create, use arrows for existing options, and Ctrl+U to clear. Esc cancels an edit or, from the form, closes the chooser. Review the checkout path and action before submitting. No agent or model is required; the task opens a shell.

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

`projects` explicitly registers paths; optional `roots` scans two directory levels for projects. Without either, the originating Rex pane's directory (or the CLI caller's directory) can suggest its Git project, but no parent directory is scanned. A local directory suggestion is not sent to another machine: enter or select the project directory on that destination. A path typed in the form is interpreted there. Git, not the configuration, determines existing checkouts and branches.

New checkout location follows this order: a project's `worktreeRoot/<worktree-name>`, the global `worktreeRoot/<primary-project-name>/<worktree-name>`, or, by default, a sibling `<main-checkout>.worktrees/<worktree-name>`. `~` refers to the destination user's home; relative configuration paths resolve against the config file's directory. Checkout locations must be outside existing checkouts and Git metadata. Collisions and escaping paths are rejected rather than renamed.

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
```

`popup` runs the chooser in the invoking terminal; `launch-popup` opens its floating UI in the source Rex window. For `launch-popup` from an external terminal, supply `--session`; inside Rex, the originating session is available automatically. `launch-popup --host` keeps the UI on the caller's server while selecting another execution host. `--host` accepts an existing Rex host label or registry ID; find exact destination session IDs with `rex -S HOST ls --json`. Remote `--repo` and `--worktree` paths must be absolute paths on the destination.

`open` accepts either `--branch` or `--worktree`. `--worktree-name` only applies to `--branch` and sets the new checkout directory name; `--name` independently labels the tab or pane. By default, a matching live tab is reused; `--additional` opens another tab, and `--split` splits a matching task or falls back to a new tab. These two flags cannot be combined. `--client ID` selects an exact Rex app client when needed. See `rex-worktrees --help` for popup origin/context flags.

## Safety and limits

A submitted checkout task can continue after the chooser closes, and closing a tab does not delete its checkout. If a launch times out or Rex reports an uncertain result, inspect Git and the destination session before retrying; a created checkout is retained even when opening Rex fails. The tool does not force checkout, switch, stash, reset, clean, or prune. Linked worktrees have separate files, HEAD, and index, but share Git refs, objects, remotes, and config. Shells are not confined to the checkout. Checkout/tab associations are stored per destination at `${XDG_STATE_HOME:-~/.local/state}/rex-worktrees/associations`; Git remains authoritative if an association becomes stale.

Local macOS execution is supported. Cross-host worktree execution is experimental; Linux destinations are not yet verified. Each destination requires its own installation and a connected Rex host. Native app navigation requires Rex Remote Control permission. Local endpoints must be Unix endpoints; Windows named pipes are not supported. For a custom local Unix server, set `REX_WORKTREES_LOCAL_ENDPOINT=unix:///absolute/path/server.sock` in the plugin environment.

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

Each [release](https://github.com/samuelho-dev/rex-worktrees/releases) includes the application's relinkable `rex-worktrees.js` bundle in the binary archive, plus matching Bun, WebKit/JavaScriptCore, and tinycc source archives. `SHA256SUMS` covers every download.

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
