import { hostname } from "node:os";
import { Cause, Context, Effect, Path, Schema } from "effect";
import { AppError, RexTaskIdentitySchema, RexIdentitySchema, RexSessionsSchema, RexSessionCreatedSchema, RexClientsSchema, RexBlocksSchema, RexViewSchema, RexCreatedSchema, RexSplitCreatedSchema, RexLayerSchema, RexDirectorySchema, RexProcessSchema, RexRegistrySchema, RexLayoutNode, RexTerminalSizeSchema, popupSize, type BlockId, type ClientId, type SessionId, type WindowId, type Environment, type PopupOrigin, type SessionSelection, type RexTaskSettings, type ServerHostId, type LaunchPlan } from "./contracts.ts";
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
export const listClients = Effect.gen(function*() {
  const result = yield* parse(RexClientsSchema, yield* rex(["api", "call", "client.list", JSON.stringify({ kinds: ["app"] })]));
  return result.clients.filter((client) => client.info?.kind === "app" && client.connection_state === "connected")
    .map((client) => ({ id: client.client_id, label: client.info?.label ?? client.client_id }));
});

export const localBlocks = Effect.fnUntraced(function*(sessionId: SessionId) {
  const host = yield* localHost;
  const result = yield* parse(RexBlocksSchema, yield* rex(["api", "call", "-s", sessionId, "session.list_blocks", JSON.stringify({ session_id: sessionId })]));
  return result.blocks.filter(item => item.host_id === host.id && item.placement === "placed");
});
export const localBlockWindow = Effect.fnUntraced(function*(sessionId: SessionId, blockId: BlockId) {
  return (yield* localBlocks(sessionId)).find(item => item.block_id === blockId)?.window_id ?? undefined;
});
export const originDirectory = Effect.fnUntraced(function*(sessionId: SessionId, blockId: BlockId) {
  if (!(yield* localBlockWindow(sessionId, blockId))) return undefined;
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

const terminalLayout = (command: readonly string[], cwd: string, label: string, onCompletion = false, size?: typeof popupSize) => ({
  block: { flavor: "com.superlogical.terminal.shell", label, options: {
    command: commandWithPath(command), shell: "none", cwd, exit: { on_completion: onCompletion }, ...(size ? { size } : {})
  } }
});

export const openTerminal = Effect.fnUntraced(function*(session: SessionSelection, name: string, cwd: string, command: readonly string[], target?: LaunchPlan["target"]) {
  const layout = terminalLayout(command, cwd, name);
  let sessionId: SessionId;
  let created: typeof RexCreatedSchema.Type | undefined;
  if (session.kind === "new") {
    const result = yield* parse(RexSessionCreatedSchema, yield* rex(["api", "call", "session.create", JSON.stringify({
      label: session.name, initial_windows: [{ window_label: name, layout }]
    })]));
    sessionId = result.session_id;
    created = result.initial_windows[0];
  } else if (target) {
    sessionId = session.id;
    const result = yield* parse(RexSplitCreatedSchema, yield* rex(["api", "call", "-s", sessionId, "session.new_split", JSON.stringify({
      session_id: sessionId, anchor_id: target.blockId, direction: "horizontal", side: "after", layout, focus: true
    })]));
    created = { window_id: target.windowId, block_ids: result.block_ids };
  } else {
    sessionId = session.id;
    created = yield* parse(RexCreatedSchema, yield* rex(["api", "call", "-s", sessionId, "session.new_window", JSON.stringify({
      session_id: sessionId, window_label: name, layout, focus: true
    })]));
  }
  const blockId = created?.block_ids[0];
  if (!created || !blockId) return yield* Effect.fail(new AppError({ message: "Rex did not return the created window and terminal" }));
  return { sessionId, windowId: created.window_id, blockId };
});

export const taskContext = Effect.fnUntraced(function*(session: SessionSelection, settings: RexTaskSettings, expectedHostId: ServerHostId) {
  const path = yield* Path.Path;
  if (settings.rexBinDir) {
    if (!path.isAbsolute(settings.rexBinDir)) return yield* Effect.fail(new AppError({ message: "REX_BIN_DIR must be absolute" }));
    process.env.REX_BIN_DIR = settings.rexBinDir;
  }
  if (settings.rexLocalEndpoint) process.env.REX_WORKTREES_LOCAL_ENDPOINT = settings.rexLocalEndpoint;
  const { REX_SESSION: sessionId, REX_BLOCK: blockId } = yield* Schema.decodeUnknownEffect(RexTaskIdentitySchema)(process.env);
  if (session.kind === "existing" && session.id !== sessionId)
    return yield* Effect.fail(new AppError({ message: "Task must run in its requested Rex session and terminal" }));
  if ((yield* localHost).id !== expectedHostId || !(yield* localBlockWindow(sessionId, blockId)))
    return yield* Effect.fail(new AppError({ message: "Task must run in a placed terminal on its requested Rex host" }));
  return { sessionId, blockId };
});

export const focus = Effect.fnUntraced(function*(sessionId: SessionId, windowId: WindowId, blockId: BlockId, clientId?: ClientId) {
  const warnings: string[] = [];
  yield* rex(["api", "call", "-s", sessionId, "session.focus_block", JSON.stringify({ session_id: sessionId, block_id: blockId })])
    .pipe(Effect.catch(error => Effect.sync(() => { warnings.push(`Could not focus Rex pane: ${Cause.pretty(Cause.fail(error))}`); })));
  if (clientId) yield* rex(["api", "call", "client.perform", JSON.stringify({
    client_id: clientId, action: "session.select", args: { session_id: sessionId, window_id: windowId }
  })]).pipe(Effect.catch(error => Effect.sync(() => { warnings.push(`Could not focus Rex app: ${Cause.pretty(Cause.fail(error))}`); })));
  return warnings.length ? warnings.join("; ") : undefined;
});

const findPane = (node: RexLayoutNode | null, blockId: BlockId): RexLayoutNode | undefined =>
  !node ? undefined : node.block_id === blockId ? node
    : node.split ? findPane(node.split.before, blockId) ?? findPane(node.split.after, blockId) : undefined;

export const openPopup = Effect.fnUntraced(function*(command: readonly string[], sessionId: SessionId, origin: PopupOrigin = {}) {
  const view = yield* parse(RexViewSchema, yield* rex(["api", "call", "-s", sessionId, "session.view", JSON.stringify({ session_id: sessionId })]));
  const source = origin.blockId ? view.windows.find(window =>
    window.layers.some(layer => layer.blocks.some(block => block.block_id === origin.blockId))) : undefined;
  if (origin.blockId && !source) return yield* Effect.fail(new AppError({ message: "Source pane is no longer in the selected Rex session" }));
  const windowId = source?.window_id ?? view.active_window_id;
  const window = view.windows.find(window => window.window_id === windowId);
  if (!windowId || !window) {
    return yield* Effect.fail(new AppError({ message: "No active Rex window for the popup" }));
  }
  const sourceOwner = source?.layers.flatMap(layer => layer.blocks).find(block => block.block_id === origin.blockId)?.owner;
  const clients = yield* listClients;
  const clientId = [sourceOwner, origin.clientId].find(id => id && clients.some(client => client.id === id));
  const popupCommand = clientId ? [...command, "--origin-client", clientId] : command;
  const blocks = window.layers.flatMap(layer => layer.blocks);
  const terminals = blocks.filter(block => block.flavor === "com.superlogical.terminal.shell");
  const terminal = terminals.find(block => block.block_id === origin.blockId)
    ?? terminals.find(block => block.block_id === window.focused_block_id) ?? terminals[0];
  // Without terminal geometry, use the available window instead of guessing a percentage.
  let width = 1, height = 1;
  if (terminal) {
    const pane = window.layers.map(layer => findPane(layer.layout, terminal.block_id)).find(node => node !== undefined);
    if (!pane) return yield* Effect.fail(new AppError({ message: "Rex terminal geometry changed before opening the popup" }));
    const size = yield* parse(RexTerminalSizeSchema, yield* rex(["block", "call", "-s", sessionId, "-b", terminal.block_id, "size"]));
    const zoomed = window.zoomed_block_id === terminal.block_id;
    // Native title-bar chrome needs one more row than the side insets.
    width = Math.min(1, (popupSize.columns + 2) * (zoomed ? 1 : pane.rect[2]) / size.columns);
    height = Math.min(1, (popupSize.rows + 3) * (zoomed ? 1 : pane.rect[3]) / size.rows);
  }
  const args = {
    session_id: sessionId, window_id: windowId,
    bounds: [(1 - width) / 2, (1 - height) / 2, width, height],
    layout: terminalLayout(popupCommand, process.cwd(), "Worktrees", true, popupSize), focus: true
  };
  const created = yield* parse(RexLayerSchema, yield* rex(["api", "call", "-s", sessionId, "session.new_layer", JSON.stringify(args)]));
  if (!created.layer_id || !created.block_ids?.some(Boolean)) return yield* Effect.fail(new AppError({ message: "Rex did not return a floating terminal layer" }));
  return created;
}, withLocalIdentity);
