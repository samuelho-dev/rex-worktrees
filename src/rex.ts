import { hostname } from "node:os";
import { Cause, Context, Effect, Path, Schema } from "effect";
import { AppError, BlockIdSchema, SessionIdSchema, RexIdentitySchema, RexSessionsSchema, RexSessionCreatedSchema, RexClientsSchema, RexWindowsSchema, RexViewSchema, RexCreatedSchema, RexLayerSchema, RexDirectorySchema, RexProcessSchema, RexRegistrySchema, type BlockId, type ClientId, type SessionId, type WindowId, type Environment, type PopupOrigin } from "./contracts.ts";
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
const readLocalIdentity = Effect.gen(function*() {
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
const LocalIdentity = Context.Reference("rex-worktrees/LocalIdentity", { defaultValue: () => readLocalIdentity });
const localIdentity = Effect.flatten(LocalIdentity);
// ponytail: share the verified endpoint only within this operation, never across user actions.
export const withLocalIdentity = Effect.provideServiceEffect(LocalIdentity, Effect.cached(readLocalIdentity));
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
  const directory = result.pwd ? localDirectoryUri(result.pwd) : undefined;
  if (directory !== undefined) return directory;
  // ponytail: a rejected or missing pane URI falls back only to this verified pane's foreground cwd.
  const processInfo = yield* parse(RexProcessSchema, yield* rex(["block", "call", "-s", sessionId, "-b", blockId, "process"]));
  const cwd = processInfo.foreground?.cwd;
  return cwd?.startsWith("/") && !cwd.includes("\0") ? cwd : undefined;
}, withLocalIdentity);


// Rex's macOS login wrapper resets PATH and drops injected settings before starting a direct command.
const commandWithPath = (command: readonly string[]) => {
  const env = [
    ...(process.env.PATH ? [`PATH=${process.env.PATH}`] : []),
    ...(process.env.REX_WORKTREES_CONFIG !== undefined ? [`REX_WORKTREES_CONFIG=${process.env.REX_WORKTREES_CONFIG}`] : [])
  ];
  return env.length ? ["/usr/bin/env", ...env, ...command] : command;
};

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
  const width = 0.68, height = 0.24; // Fixed bounds for the entire popup lifetime.
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
