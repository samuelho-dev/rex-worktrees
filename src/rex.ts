import { hostname } from "node:os";
import { Cause, Effect, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { AppError, BlockIdSchema, SessionIdSchema, RexIdentitySchema, RexSessionsSchema, RexSessionCreatedSchema, RexClientsSchema, RexWindowsSchema, RexViewSchema, RexResizedSchema, RexTerminalSizeSchema, RexCreatedSchema, RexLayerSchema, RexDirectorySchema, RexProcessSchema, RexRegistrySchema, type BlockId, type ClientId, type SessionId, type WindowId, type Environment, type PopupOrigin, type PopupSize, type PopupSizer, type PopupBounds } from "./contracts.ts";
import { run } from "./process.ts";
const localName = hostname().toLowerCase().replace(/\.$/, "").replace(/\.local$/, "");
export const localDirectoryUri = (raw: string): string | undefined => {
  if (raw.startsWith("/")) return raw.includes("\0") ? undefined : raw;
  try {
    const url = new URL(raw);
    const authority = url.hostname.toLowerCase().replace(/\.$/, "").replace(/\.local$/, "");
    if (!raw.startsWith("file://") || url.protocol !== "file:" ||
      (authority && authority !== "localhost" && authority !== localName) ||
      url.username || url.password || url.search || url.hash || !url.pathname.startsWith("/")) return undefined;
    const directory = decodeURIComponent(url.pathname);
    return directory.startsWith("/") && !directory.includes("\0") ? directory : undefined;
  } catch {
    return undefined;
  }
};

const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, raw: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw);

// Discover the current machine through Rex, never from a platform-specific socket path.
const nativeEnv = (): Environment => {
  const environment: Environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "REX_SERVER" && key !== "REX_HOST" && key !== "REX_CLIENT" && value !== undefined) environment[key] = value;
  }
  return environment;
};
const binary = Effect.fnUntraced(function*(path: Path.Path) {
  const binDir = process.env.REX_BIN_DIR;
  if (binDir !== undefined && !path.isAbsolute(binDir)) return yield* Effect.fail(new AppError({ message: "REX_BIN_DIR must be an absolute directory" }));
  return binDir === undefined ? "rex" : path.join(binDir, "rex");
});
export const machinesRegistry = Effect.gen(function*() {
  const path = yield* Path.Path;
  return yield* parse(RexRegistrySchema, yield* run(yield* binary(path), ["hosts", "list", "--json"], undefined, nativeEnv()));
});
const localIdentity = Effect.gen(function*() {
  const path = yield* Path.Path;
  const endpoint = process.env.REX_WORKTREES_LOCAL_ENDPOINT;
  if (endpoint !== undefined && !endpoint.startsWith("unix:///")) {
    return yield* Effect.fail(new AppError({ message: "Rex did not provide a local Unix endpoint; set REX_WORKTREES_LOCAL_ENDPOINT to this machine's native Unix endpoint" }));
  }
  const identity = yield* parse(RexIdentitySchema, yield* run(yield* binary(path),
    [...(endpoint ? ["-S", endpoint] : []), "--autostart=false", "whoami", "--json"], undefined, nativeEnv()));
  if (!identity.endpoint.startsWith("unix:///") || identity.principal.transport !== "unix" ||
    (endpoint !== undefined && identity.endpoint !== endpoint)) {
    return yield* Effect.fail(new AppError({ message: "Rex is not connected to the selected local Unix server" }));
  }
  return identity;
});
const localEndpoint = Effect.gen(function*() {
  const explicit = process.env.REX_WORKTREES_LOCAL_ENDPOINT;
  if (explicit !== undefined) {
    if (explicit.startsWith("unix:///")) return explicit;
    return yield* Effect.fail(new AppError({ message: "Rex did not provide a local Unix endpoint; set REX_WORKTREES_LOCAL_ENDPOINT to this machine's native Unix endpoint" }));
  }
  return (yield* localIdentity).endpoint;
});
export const rex = Effect.fnUntraced(function*(args: readonly string[]) {
  const path = yield* Path.Path;
  return yield* run(yield* binary(path), ["-S", yield* localEndpoint, "--autostart=false", ...args], undefined, nativeEnv());
});
export const remoteRex = Effect.fnUntraced(function*(selector: string, args: readonly string[]) {
  const path = yield* Path.Path;
  return yield* run(yield* binary(path), ["-S", selector, "--autostart=false", "--timeout", "30s", ...args], undefined, nativeEnv());
});
export const remoteIdentity = Effect.fnUntraced(function*(selector: string) {
  return yield* parse(RexIdentitySchema, yield* remoteRex(selector, ["whoami", "--json"]));
});
export const localHost = Effect.gen(function*() {
  const identity = yield* localIdentity;
  return { id: identity.host_id, label: "This machine" };
});

export const listSessions = Effect.gen(function*() {
  const result = yield* parse(RexSessionsSchema, yield* rex(["ls", "--json"]));
  return result.sessions.map((session) => ({ id: session.session_id, label: session.label }));
});
export const createSession = Effect.fnUntraced(function*(name: string) {
  const result = yield* parse(RexSessionCreatedSchema, yield* rex(["api", "call", "session.create", JSON.stringify({ label: name })]));
  return result.session_id;
});
export const listClients = Effect.gen(function*() {
  const result = yield* parse(RexClientsSchema, yield* rex(["client", "ls", "--json"]));
  return result.clients.filter((client) => client.info?.kind === "app" && client.connection_state === "connected")
    .map((client) => ({ id: client.client_id, label: client.info?.label ?? client.client_id }));
});

export const windowList = Effect.fnUntraced(function*(sessionId: SessionId) {
  const result = yield* parse(RexWindowsSchema, yield* rex(["window", "ls", "-s", sessionId, "--json"]));
  return result.windows;
});
export const originDirectory = Effect.fnUntraced(function*(sessionId: SessionId, blockId: BlockId) {
  const host = yield* localHost;
  const windows = yield* windowList(sessionId);
  if (!windows.some((window) => window.layers.some((layer) =>
    layer.blocks?.some((block) => block.block_id === blockId && block.host_id === host.id)))) return undefined;
  const raw = yield* rex(["block", "call", "-s", sessionId, "-b", blockId, "pwd"]);
  const result = yield* parse(RexDirectorySchema, raw);
  if (result.pwd) return localDirectoryUri(result.pwd);
  // ponytail: inspect only this verified pane's foreground when Rex has no reported directory.
  const processInfo = yield* parse(RexProcessSchema, yield* rex(["block", "call", "-s", sessionId, "-b", blockId, "process"]));
  const cwd = processInfo.foreground?.cwd;
  return cwd?.startsWith("/") && !cwd.includes("\0") ? cwd : undefined;
});

// ponytail: proportional feedback uses only the popup's OWN cell size; no source-pane or pixel-chrome guesses.
export const fitPopupBounds = (bounds: PopupBounds, preferred: PopupSize, observed: PopupSize): PopupBounds | undefined => {
  if (![...bounds, preferred.columns, preferred.rows, observed.columns, observed.rows].every(Number.isFinite) ||
    bounds[2] <= 0 || bounds[3] <= 0 || observed.columns <= 0 || observed.rows <= 0 ||
    preferred.columns <= 0 || preferred.rows <= 0) return undefined;
  const wantsWidth = observed.columns < preferred.columns || observed.columns > preferred.columns + 2;
  const wantsHeight = observed.rows < preferred.rows || observed.rows > preferred.rows + 1;
  const width = wantsWidth ? Math.min(0.92, bounds[2] * (preferred.columns + 1) / observed.columns) : bounds[2];
  const height = wantsHeight ? Math.min(0.88, bounds[3] * (preferred.rows + 1) / observed.rows) : bounds[3];
  const next: PopupBounds = [(1 - width) / 2, (1 - height) / 2, width, height];
  return (Math.abs(width - bounds[2]) > 1e-9 || Math.abs(height - bounds[3]) > 1e-9) ? next : undefined;
};

export const makePopupSizer = Effect.gen(function*() {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let endpoint: string | undefined;
  const localRex = Effect.fnUntraced(function*(args: readonly string[]) {
    endpoint ??= yield* localEndpoint.pipe(Effect.provideService(Path.Path, path), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    return yield* run(yield* binary(path), ["-S", endpoint, "--autostart=false", ...args], undefined, nativeEnv())
      .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  });
  const sessionId = process.env.REX_SESSION === undefined ? undefined : yield* Schema.decodeUnknownEffect(SessionIdSchema)(process.env.REX_SESSION);
  const blockId = process.env.REX_BLOCK === undefined ? undefined : yield* Schema.decodeUnknownEffect(BlockIdSchema)(process.env.REX_BLOCK);
  let pending: string | undefined;
  let settled: string | undefined;
  let warning: string | undefined;
  let targetSize: string | undefined;
  let attempts = 0;
  const resize: PopupSizer = Effect.fnUntraced(function*(preferred: PopupSize, observed: PopupSize) {
    if (!sessionId || !blockId || !observed.columns || !observed.rows) return undefined;
    const desired = `${preferred.columns}x${preferred.rows}`;
    if (targetSize !== desired) { targetSize = desired; settled = undefined; attempts = 0; }
    const seen = `${observed.columns}x${observed.rows}`;
    if (seen === pending) return warning; // wait for the native terminal resize event, not another keypress
    if (pending !== undefined && seen !== pending) pending = undefined;
    const target = `${preferred.columns}x${preferred.rows}:${seen}`;
    if (settled === target) return warning;
    if (attempts >= 5) return warning = observed.rows < preferred.rows || observed.columns < 20
      ? "Could not fit Rex popup: reached the native resize limit; enlarge the Rex window" : undefined;
    const view = yield* parse(RexViewSchema, yield* localRex(["api", "call", "-s", sessionId, "session.view", JSON.stringify({ session_id: sessionId })]));
    const layer = view.windows.flatMap(window => window.layers)
      .find(layer => layer.kind === "floating" && layer.blocks.some(block => block.block_id === blockId));
    if (!layer?.layer_id || !layer.bounds) { settled = target; return undefined; } // ordinary direct/tiled TUI is not ours to resize
    const size = yield* parse(RexTerminalSizeSchema, yield* localRex(["block", "call", "-s", sessionId, "-b", blockId, "size"]));
    if (!size.owner) return undefined; // never cache Rex's unowned default 80x24
    if (size.columns !== observed.columns || size.rows !== observed.rows) { settled = target; return undefined; }
    const bounds = fitPopupBounds(layer.bounds, preferred, observed);
    if (!bounds) {
      settled = target;
      attempts = 0;
      return warning = observed.rows < preferred.rows || observed.columns < 20
        ? "Could not fit Rex popup: window is too small for the form" : undefined;
    }
    yield* parse(RexResizedSchema, yield* localRex(["api", "call", "-s", sessionId, "session.resize_layer",
      JSON.stringify({ session_id: sessionId, layer_id: layer.layer_id, bounds })]));
    attempts++;
    pending = seen;
    warning = undefined;
    return undefined;
  }, (effect, preferred, observed) => effect.pipe(Effect.catch(error => Effect.sync(() => {
    settled = `${preferred.columns}x${preferred.rows}:${observed.columns}x${observed.rows}`;
    return warning = `Could not fit Rex popup: ${Cause.pretty(Cause.fail(error))}`;
  }))));
  return resize;
});

// Rex's macOS login wrapper resets PATH before starting a direct command.
const commandWithPath = (command: readonly string[]) => process.env.PATH
  ? ["/usr/bin/env", `PATH=${process.env.PATH}`, ...command] : command;

export const createTab = Effect.fnUntraced(function*(sessionId: SessionId, name: string, cwd: string, command: readonly string[]) {
  const result = yield* parse(RexCreatedSchema, yield* rex(["window", "new", "-s", sessionId, name, "-c", cwd, "--shell=none", "--keep-open", "--json", "--", ...commandWithPath(command)]));
  const blockId = result.block_ids[0];
  if (!blockId) return yield* Effect.fail(new AppError({ message: "Rex created a tab without a terminal block" }));
  if (!result.window_id) return yield* Effect.fail(new AppError({ message: "Rex did not return a window ID" }));
  return { windowId: result.window_id, blockId };
});

export const createSplit = Effect.fnUntraced(function*(sessionId: SessionId, windowId: WindowId, blockId: BlockId, name: string, cwd: string, command: readonly string[]) {
  const result = yield* parse(RexCreatedSchema, yield* rex(["split", "-s", sessionId, "-b", blockId, "--split=right", "--label", name, "-c", cwd, "--shell=none", "--keep-open", "--json", "--", ...commandWithPath(command)]));
  const created = result.block_ids.find((id) => id !== blockId);
  if (!created) return yield* Effect.fail(new AppError({ message: "Rex created a split without a new terminal block" }));
  return { windowId: result.window_id ?? windowId, blockId: created };
});

export const focus = Effect.fnUntraced(function*(sessionId: SessionId, windowId: WindowId, clientId?: ClientId, blockId?: BlockId) {
  const warnings: string[] = [];
  yield* rex(["focus", "-s", sessionId, windowId]).pipe(Effect.catch((error) => Effect.sync(() => { warnings.push(Cause.pretty(Cause.fail(error))); })));
  if (clientId) {
    yield* rex(["-C", clientId, "do", "session.select", `session_id=${sessionId}`, `window_id=${windowId}`])
      .pipe(Effect.catch((error) => Effect.sync(() => { warnings.push(`Could not focus Rex app: ${Cause.pretty(Cause.fail(error))}`); })));
  }
  if (blockId) {
    yield* rex(["focus", "-s", sessionId, "-w", windowId, blockId])
      .pipe(Effect.catch((error) => Effect.sync(() => { warnings.push(`Could not focus Rex pane: ${Cause.pretty(Cause.fail(error))}`); })));
  }
  return warnings.length ? warnings.join("; ") : undefined;
});

export const openPopup = Effect.fnUntraced(function*(command: readonly string[], sessionId: SessionId, origin: PopupOrigin = {}) {
  const path = yield* Path.Path;
  const endpoint = (yield* localIdentity).endpoint;
  const program = yield* binary(path);
  const localRex = (args: readonly string[]) =>
    run(program, ["-S", endpoint, "--autostart=false", ...args], undefined, nativeEnv());
  const view = yield* parse(RexViewSchema, yield* localRex(["api", "call", "-s", sessionId, "session.view", JSON.stringify({ session_id: sessionId })]));
  const source = origin.blockId ? view.windows.find(window =>
    window.layers.some(layer => layer.blocks.some(block => block.block_id === origin.blockId))) : undefined;
  if (origin.blockId && !source) return yield* Effect.fail(new AppError({ message: "Source pane is no longer in the selected Rex session" }));
  const windowId = source?.window_id ?? view.active_window_id;
  if (!windowId || !view.windows.some(window => window.window_id === windowId)) {
    return yield* Effect.fail(new AppError({ message: "No active Rex window for the popup" }));
  }
  const sourceOwner = source?.layers.flatMap(layer => layer.blocks).find(block => block.block_id === origin.blockId)?.owner;
  const clients = (yield* parse(RexClientsSchema, yield* localRex(["client", "ls", "--json"]))).clients
    .filter(client => client.info?.kind === "app" && client.connection_state === "connected");
  const clientId = [sourceOwner, origin.clientId].find(id => id && clients.some(client => client.client_id === id));
  const popupCommand = clientId ? [...command, "--managed-popup", "--origin-client", clientId] : [...command, "--managed-popup"];
  const width = 0.68, height = 0.35; // ponytail: bootstrap only; the popup fits its own measured terminal after rendering
  const args = {
    session_id: sessionId, window_id: windowId,
    bounds: [(1 - width) / 2, (1 - height) / 2, width, height],
    layout: { block: { flavor: "com.superlogical.terminal.shell", options: { command: commandWithPath(popupCommand), shell: "none", cwd: process.cwd(), exit: { on_completion: true } } } }, focus: true
  };
  const created = yield* parse(RexLayerSchema, yield* localRex(["api", "call", "-s", sessionId, "session.new_layer", JSON.stringify(args)]));
  if (!created.layer_id || !created.block_ids?.some(Boolean)) return yield* Effect.fail(new AppError({ message: "Rex did not return a floating terminal layer" }));
  return created;
});

export const closeManagedPopup = Effect.gen(function*() {
  const sessionId = process.env.REX_SESSION === undefined ? undefined : yield* Schema.decodeUnknownEffect(SessionIdSchema)(process.env.REX_SESSION);
  const blockId = process.env.REX_BLOCK === undefined ? undefined : yield* Schema.decodeUnknownEffect(BlockIdSchema)(process.env.REX_BLOCK);
  if (!sessionId || !blockId) {
    return yield* Effect.fail(new AppError({ message: "Cannot close managed Rex popup without its own session and block" }));
  }
  const path = yield* Path.Path;
  const endpoint = (yield* localIdentity).endpoint;
  const program = yield* binary(path);
  const localRex = (args: readonly string[]) =>
    run(program, ["-S", endpoint, "--autostart=false", ...args], undefined, nativeEnv());
  const view = yield* parse(RexViewSchema, yield* localRex(["api", "call", "-s", sessionId, "session.view", JSON.stringify({ session_id: sessionId })]));
  if (!view.windows.some(window => window.layers.some(layer =>
    layer.blocks.some(block => block.block_id === blockId)))) {
    return yield* Effect.fail(new AppError({ message: "Managed Rex popup block is no longer in its own session" }));
  }
  yield* localRex(["block", "close", "-s", sessionId, blockId]);
});
