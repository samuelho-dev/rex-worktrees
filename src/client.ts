import { Effect, Schema } from "effect";
import { dispatchHost } from "./host.ts";
import { AppError, RexActionsSchema, RexHelperArgsSchema, RexWorktreesResponseSchema, type CloneInput, type ClonePlan, type DestinationHost, type LaunchInput, type LaunchPlan, type Machine, type Request, type RequestBody, type Response } from "./contracts.ts";
import { localHost, machinesRegistry, remoteIdentity, remoteRex } from "./rex.ts";
const fail = (message: string) => Effect.fail(new AppError({ message }));

export const listMachines = Effect.gen(function*() {
  const registry = yield* machinesRegistry;
  const machines: Machine[] = [
    { key: "local", label: registry.home.this_machine && registry.home.label || "This machine", local: true, selector: process.env.REX_WORKTREES_LOCAL_ENDPOINT ?? "local" },
    ...registry.hosts.map(({ host }) => ({ key: host.id, label: host.label, local: false, selector: host.label }))
  ];
  return machines;
});

export const connectMachine = Effect.fnUntraced(function*(machine: Machine) {
  const choices = yield* listMachines;
  const current = choices.find(choice => choice.key === machine.key && choice.local === machine.local);
  if (!current) return yield* fail(`Rex machine ${machine.label} is no longer registered; choose another machine`);
  if (current.local) return { ...current, hostId: (yield* localHost).id };
  const identity = yield* remoteIdentity(current.selector);
  const registered = (yield* machinesRegistry).hosts.find(entry => entry.host.id === current.key);
  if (!registered?.host.endpoints.includes(identity.endpoint)) {
    return yield* fail(`Rex machine ${current.label} resolved to an unexpected server; refusing to route remotely`);
  }
  const raw = yield* remoteRex(current.selector, ["actions", "--json"]);
  const actions = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RexActionsSchema))(raw);
  const helper = actions.actions.find(action => action.name === "worktrees_request");
  if (!helper) {
    return yield* fail(`rex-worktrees is not installed on ${current.label}. Build and run rex-worktrees setup on that machine, then reload its Rex config.`);
  }
  yield* Schema.decodeUnknownEffect(RexHelperArgsSchema)(helper.args);
  return { ...current, hostId: identity.host_id };
});

const request = Effect.fnUntraced(function*(host: DestinationHost, command: readonly string[], body: RequestBody) {
  const encoded: Request = { version: 3, hostId: host.hostId, ...body };
  let response: Response;
  if (host.local) {
    response = yield* dispatchHost(encoded, command);
  } else {
    const current = yield* connectMachine(host);
    if (current.hostId !== host.hostId) return yield* fail(`Rex host identity changed for ${host.label}; reconnect before continuing`);
    const raw = yield* remoteRex(current.selector, ["do", "worktrees_request", "--args", JSON.stringify({ request: JSON.stringify(encoded) }), "--json"]);
    response = yield* Schema.decodeUnknownEffect(RexWorktreesResponseSchema)(raw);
  }
  if (response.hostId !== host.hostId || response.version !== 3 ||
    response.kind !== body.kind && !(body.kind === "project" && response.kind === "project-missing" && response.path === body.path))
    return yield* fail(`Unexpected Rex host/protocol response from ${host.label}; update rex-worktrees on that machine, run setup, and reload its Rex config`);
  return response;
});

export const discover = Effect.fnUntraced(function*(host: DestinationHost, command: readonly string[], context?: string) {
  const result = yield* request(host, command, { kind: "discover", ...(host.local && context ? { context } : {}) });
  if (result.kind !== "discover") return yield* fail("Unexpected discovery response");
  return { sessions: result.sessions, clients: result.clients, projects: result.projects, roots: result.roots ?? [], cloneRoot: result.cloneRoot, ...(result.checkout ? { checkout: result.checkout } : {}) };
});
export const inspectProject = Effect.fnUntraced(function*(host: DestinationHost, command: readonly string[], path: string) {
  const result = yield* request(host, command, { kind: "project", path });
  if (result.kind === "project-missing") return yield* fail(`Project directory does not exist: ${result.path}`);
  if (result.kind !== "project") return yield* fail("Unexpected project response");
  return { project: result.project, checkout: result.checkout, worktrees: result.worktrees, branches: result.branches, revisions: result.revisions };
});
export const inspectWorktrees = Effect.fnUntraced(function*(host: DestinationHost, command: readonly string[], repo: string) {
  const result = yield* request(host, command, { kind: "worktrees", repo });
  if (result.kind !== "worktrees") return yield* fail("Unexpected worktree response");
  return { repository: result.repository, worktrees: result.worktrees, branches: result.branches, revisions: result.revisions };
});
export const inspectRevision = Effect.fnUntraced(function*(host: DestinationHost, command: readonly string[], repo: string, revision: string) {
  const result = yield* request(host, command, { kind: "revision", repo, revision });
  if (result.kind !== "revision") return yield* fail("Unexpected revision response");
  return result.revision;
});
export const review = Effect.fnUntraced(function*(host: DestinationHost, command: readonly string[], input: LaunchInput) {
  const result = yield* request(host, command, { kind: "plan", input });
  if (result.kind !== "plan") return yield* fail("Unexpected review response");
  return result.plan;
});
export const submit = Effect.fnUntraced(function*(host: DestinationHost, command: readonly string[], input: LaunchInput, reviewed: LaunchPlan) {
  if (reviewed.hostId !== host.hostId) return yield* fail("Reviewed destination belongs to another host");
  const result = yield* request(host, command, { kind: "launch", input, reviewed });
  if (result.kind !== "launch") return yield* fail("Unexpected launch response");
  return result.result;
});

export const sourceForClone = Effect.fnUntraced(function*(host: DestinationHost, command: readonly string[], repo: string) {
  const result = yield* request(host, command, { kind: "clone-source", repo });
  if (result.kind !== "clone-source") return yield* fail("Unexpected clone source response");
  return result.source;
});
export const reviewClone = Effect.fnUntraced(function*(host: DestinationHost, command: readonly string[], input: CloneInput) {
  const result = yield* request(host, command, { kind: "clone-plan", input });
  if (result.kind !== "clone-plan") return yield* fail("Unexpected clone review response");
  return result.plan;
});
export const submitClone = Effect.fnUntraced(function*(host: DestinationHost, command: readonly string[], input: CloneInput, reviewed: ClonePlan) {
  if (reviewed.hostId !== host.hostId) return yield* fail("Reviewed clone destination belongs to another host");
  const result = yield* request(host, command, { kind: "clone-launch", input, reviewed });
  if (result.kind !== "clone-launch") return yield* fail("Unexpected clone launch response");
  return result.result;
});
