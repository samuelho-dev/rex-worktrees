import { Cause, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolveWorktreeRoot } from "./config.ts";
import { AppError, CommandError, BlockIdSchema, RexProcessSchema, RexDirectorySchema, type BlockId, type ServerHostId, type SessionId, type WindowId, type TaskRequest, type LaunchInput, type LaunchPlan, type LaunchResult, type Association } from "./contracts.ts";
import { createWorktree, listBranches, listWorktrees, missing, planWorktree, repository, repositoryHead } from "./git.ts";
import { associations, saveAssociation } from "./state.ts";
import { createSplit, createTab, focus, listClients, listSessions, localDirectoryUri, localHost, rex, windowList } from "./rex.ts";

const fail = (message: string) => Effect.fail(new AppError({ message }));
const canonical = Effect.fnUntraced(function*(path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(path);
});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, raw: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw);
const staleBlock = (error: unknown, sessionId: SessionId, blockId: BlockId) => {
  if (!Schema.is(CommandError)(error) || error.exitCode !== 3) return false;
  const diagnostic = (error.stderr.trim() || error.stdout.trim()).trim();
  return diagnostic === `Error: block target "${blockId}" not found` ||
    diagnostic === `Error: block target "${blockId}" not found: session scope: session "${sessionId}" not found`;
};

const liveBlock = Effect.fnUntraced(function*(sessionId: SessionId, windowId: WindowId, blockId: BlockId, hostId: ServerHostId, path: string) {
  const windows = yield* windowList(sessionId);
  const window = windows.find((entry) => entry.window_id === windowId);
  if (!window) return false;
  const block = window.layers.flatMap((layer) => layer.blocks ?? []).find((entry) => entry.block_id === blockId);
  if (!block || block.host_id !== hostId) return false;
  const raw = yield* Effect.catchIf(rex(["block", "call", "-s", sessionId, "-b", blockId, "process"]),
    error => staleBlock(error, sessionId, blockId), () => Effect.succeed(""));
  if (!raw) return false; // A block may close between the layout snapshot and inspection.
  const processInfo = yield* decode(RexProcessSchema, raw);
  if (processInfo.last_exit || !processInfo.foreground) return false;
  // Rex's process cwd can belong to the task supervisor, not its interactive shell.
  const reported = yield* Effect.catchIf(rex(["block", "call", "-s", sessionId, "-b", blockId, "pwd"]),
    error => staleBlock(error, sessionId, blockId), () => Effect.succeed(""))
    .pipe(Effect.flatMap((raw) => raw ? decode(RexDirectorySchema, raw) : Effect.succeed({ pwd: undefined })));
  if (!reported.pwd) return false;
  const pathname = localDirectoryUri(reported.pwd);
  if (!pathname) return false;
  const cwd = yield* Effect.catchIf(canonical(pathname), error => missing(error), () => Effect.succeed(""));
  return cwd === path ? window.label : false;
});

export const planLaunch = Effect.fnUntraced(function*(input: LaunchInput, expectedHostId?: ServerHostId) {
  const host = yield* localHost;
  if (expectedHostId && host.id !== expectedHostId) return yield* fail(`Wrong Rex host: expected ${expectedHostId}, got ${host.id}`);
  if (!(yield* listSessions).some((item) => item.id === input.sessionId)) return yield* fail(`Rex session ${input.sessionId} does not exist locally`);
  const clients = yield* listClients;
  if (input.clientId && !clients.some((item) => item.id === input.clientId)) return yield* fail(`Rex app client ${input.clientId} is not connected locally`);
  const clientId = input.clientId ?? (clients.length === 1 ? clients[0]?.id : undefined);
  if (!!input.branch === !!input.path) return yield* fail("Select exactly one branch or existing worktree path");
  if (input.path && input.worktreeName !== undefined) return yield* fail("Worktree name only applies to a branch checkout");
  const repo = yield* repository(input.repo);
  const worktreeRoot = input.branch ? yield* resolveWorktreeRoot(repo.path) : undefined;
  let path: string;
  let branch: string | null;
  let checkout: LaunchPlan["checkout"];
  let base: LaunchPlan["base"];
  if (input.branch) {
    const destination = yield* planWorktree(repo.path, input.branch, worktreeRoot, input.worktreeName);
    path = destination.path;
    branch = input.branch;
    checkout = destination.existing ? "existing" : (yield* listBranches(repo.path)).includes(branch) ? "attach" : "create";
    if (checkout === "create") base = yield* repositoryHead(repo.path);
  } else {
    if (!input.path) return yield* fail("Select an existing worktree path");
    path = yield* canonical(input.path);
    const tree = (yield* listWorktrees(repo.path)).find((entry) => entry.path === path);
    if (!tree) return yield* fail(`${path} is not a Git worktree of ${repo.path}`);
    branch = tree.branch;
    checkout = "existing";
  }
  let warning: string | undefined;
  const records = yield* associations.pipe(Effect.catch((error) => Effect.sync((): Association[] => {
    warning = Cause.pretty(Cause.fail(error));
    return [];
  })));
  if (!clientId && clients.length > 1) warning = [warning, "Multiple Rex apps are connected; select the session in the intended app"].filter(Boolean).join("; ");
  let target: LaunchPlan["target"];
  for (const entry of records) {
    if (entry.hostId !== host.id || entry.commonDir !== repo.commonDir || entry.path !== path || entry.sessionId !== input.sessionId) continue;
    const label = yield* liveBlock(entry.sessionId, entry.windowId, entry.blockId, host.id, path);
    if (label !== false) {
      target = { windowId: entry.windowId, blockId: entry.blockId, label };
      break;
    }
  }
  const action: LaunchPlan["action"] = input.split && target ? "split" : target && !input.additional && !input.split ? "focus" : "new-tab";
  const nameRole: LaunchPlan["nameRole"] = action === "focus" ? "none" : action === "split" ? "pane" : "tab";
  if (nameRole !== "none" && (!input.name.trim() || input.name.startsWith("-") || /[\p{ASCII}&&\p{Cc}]/v.test(input.name))) {
    return yield* fail(`Invalid Rex ${nameRole} name`);
  }
  const detail = input.split && !target ? "No live tab for this checkout; opening a new tab instead." :
    checkout === "existing" && !!input.branch
      ? `Branch ${branch} is already checked out; ${action === "focus" ? "focusing its existing tab" : "opening its existing worktree"}.`
      : checkout === "attach" ? `Branch ${branch} already exists; attaching a checkout, not creating the branch.` : undefined;
  const plan: LaunchPlan = {
    input: { ...input, repo: repo.path, ...(input.path ? { path } : {}) },
    hostId: host.id, sessionId: input.sessionId, ...(clientId ? { clientId } : {}), path, branch, checkout,
    ...(worktreeRoot ? { worktreeRoot } : {}),
    ...(base ? { base } : {}), action, ...(target ? { target } : {}),
    nameRole, ...(nameRole !== "none" ? { name: input.name } : {}),
    label: action === "focus" ? "Focus existing tab" : checkout === "create" ? "Create worktree & open" :
      checkout === "attach" ? "Attach branch & open" : action === "split" ? "Open pane" : "Open tab",
    ...(detail ? { detail } : {}), ...(warning ? { warning } : {})
  };
  return plan;
});

export const sameLaunchPlan = (a: LaunchPlan, b: LaunchPlan): boolean =>
  a.hostId === b.hostId && a.worktreeRoot === b.worktreeRoot &&
  a.sessionId === b.sessionId && a.clientId === b.clientId &&
  a.input.repo === b.input.repo && a.input.sessionId === b.input.sessionId &&
  a.input.branch === b.input.branch && a.input.path === b.input.path && a.input.worktreeName === b.input.worktreeName &&
  a.input.name === b.input.name && a.input.clientId === b.input.clientId &&
  a.input.additional === b.input.additional && a.input.split === b.input.split &&
  a.path === b.path && a.branch === b.branch && a.checkout === b.checkout &&
  a.action === b.action && a.nameRole === b.nameRole && a.name === b.name &&
  a.base?.head === b.base?.head && a.base?.branch === b.base?.branch &&
  a.target?.windowId === b.target?.windowId && a.target?.blockId === b.target?.blockId &&
  a.target?.label === b.target?.label;

export const launch = Effect.fnUntraced(function*(input: LaunchInput, command: readonly string[], reviewed?: LaunchPlan, expectedHostId?: ServerHostId) {
  const pathService = yield* Path.Path;
  if (!command[0] || !pathService.isAbsolute(command[0])) return yield* fail("The task executable must be an absolute path");
  const plan = yield* planLaunch(input, expectedHostId);
  if (reviewed && !sameLaunchPlan(reviewed, plan)) return yield* fail("Launch plan changed since review; inspect the destination before submitting again");
  if (plan.action === "focus") {
    const target = plan.target;
    if (!target) return yield* fail("The reviewed focus target is no longer available");
    const warning = [plan.warning, yield* focus(plan.sessionId, target.windowId, plan.clientId, target.blockId)].filter(Boolean).join("; ") || undefined;
    const result: LaunchResult = { hostId: plan.hostId, sessionId: plan.sessionId, windowId: target.windowId, blockId: target.blockId, path: plan.path,
      pending: false, action: plan.action, warning };
    return result;
  }
  const repo = yield* repository(plan.input.repo);
  const request: TaskRequest = {
    repo: repo.path, path: plan.path, commonDir: repo.commonDir, sessionId: plan.sessionId, hostId: plan.hostId,
    ...(process.env.REX_BIN_DIR ? { rexBinDir: process.env.REX_BIN_DIR } : {}),
    ...(process.env.REX_WORKTREES_LOCAL_ENDPOINT ? { rexLocalEndpoint: process.env.REX_WORKTREES_LOCAL_ENDPOINT } : {}),
    ...(plan.input.branch ? { branch: plan.input.branch } : {}),
    ...(plan.input.worktreeName !== undefined ? { worktreeName: plan.input.worktreeName } : {}),
    ...(plan.base ? { base: plan.base.head } : {}),
    ...(plan.worktreeRoot ? { worktreeRoot: plan.worktreeRoot } : {}),
    ...(plan.checkout !== "create" ? { checkout: plan.checkout } : {})
  };
  const argv = [...command, "task", JSON.stringify(request)];
  // The task process owns creation and persists the association before starting its shell.
  const target = plan.target;
  const name = plan.name;
  if (!name) return yield* fail("The reviewed Rex tab name is no longer available");
  const created = plan.action === "split"
    ? target ? yield* createSplit(plan.sessionId, target.windowId, target.blockId, name, plan.path, argv) : yield* fail("The reviewed split target is no longer available")
    : yield* createTab(plan.sessionId, name, plan.checkout === "existing" ? plan.path : repo.path, argv);
  const warning = [plan.warning, yield* focus(plan.sessionId, created.windowId, plan.clientId, created.blockId)].filter(Boolean).join("; ") || undefined;
  const result: LaunchResult = { hostId: plan.hostId, sessionId: plan.sessionId, windowId: created.windowId, blockId: created.blockId, path: plan.path,
    pending: true, action: plan.action, warning };
  return result;
});

const shell = Effect.fnUntraced(function*(cwd: string) {
  const path = yield* Path.Path;
  const program = process.env.SHELL || "/bin/sh";
  if (!path.isAbsolute(program)) return yield* fail("SHELL must be an absolute executable path");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(program, path.basename(program) === "sh" ? ["-i"] : ["-l", "-i"], {
    cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit"
  }));
  const code = yield* child.exitCode;
  if (code !== 0) return yield* fail(`Shell exited with status ${code}`);
}, Effect.scoped);

export const task = Effect.fnUntraced(function*(request: TaskRequest) {
  if (request.rexBinDir) {
    const path = yield* Path.Path;
    if (!path.isAbsolute(request.rexBinDir)) return yield* fail("REX_BIN_DIR must be an absolute directory");
    process.env.REX_BIN_DIR = request.rexBinDir;
  }
  if (request.rexLocalEndpoint) process.env.REX_WORKTREES_LOCAL_ENDPOINT = request.rexLocalEndpoint;
  const host = yield* localHost;
  if (host.id !== request.hostId) return yield* fail(`Wrong Rex task host: expected ${request.hostId}, got ${host.id}`);
  if (!request.branch && request.worktreeName !== undefined) return yield* fail("Worktree name only applies to a branch checkout");
  if (process.env.REX_SESSION !== request.sessionId || !process.env.REX_BLOCK) return yield* fail("Task must run in its requested Rex session and terminal");
  const blockId = yield* Schema.decodeUnknownEffect(BlockIdSchema)(process.env.REX_BLOCK);
  if (!(yield* listSessions).some((item) => item.id === request.sessionId)) return yield* fail("Requested Rex session no longer exists");
  const current = yield* repository(request.repo);
  if (current.commonDir !== request.commonDir || current.path !== request.repo) return yield* fail("Repository identity changed since launch");
  let path: string;
  if (request.branch) {
    const plan = yield* planWorktree(request.repo, request.branch, request.worktreeRoot, request.worktreeName);
    if (plan.path !== request.path || (request.checkout === "existing" && !plan.existing)) return yield* fail("Worktree destination changed since launch");
    if (request.checkout === "existing") {
      path = yield* canonical(request.path);
    } else {
      const created = yield* createWorktree(request.repo, request.branch, {
        ...(request.checkout === "attach" ? { attachOnly: true } : {}),
        ...(request.base ? { startPoint: request.base } : {}),
        ...(request.worktreeName !== undefined ? { worktreeName: request.worktreeName } : {}),
        ...(request.worktreeRoot ? { worktreeRoot: request.worktreeRoot } : {})
      });
      path = yield* canonical(created.path);
    }
  } else {
    path = yield* canonical(request.path);
    const trees = yield* listWorktrees(request.repo);
    if (!trees.some((tree) => tree.path === path)) return yield* fail("Selected worktree no longer belongs to repository");
  }
  if (path !== request.path) return yield* fail(`Worktree path changed; checkout remains at ${path}`);
  const windows = yield* windowList(request.sessionId).pipe(Effect.catch((error) => Effect.sync(() => {
    console.error(`Worktree ${path} is available; cannot inspect Rex terminal for association: ${Cause.pretty(Cause.fail(error))}`);
    return [];
  })));
  const entry = windows.find((window) => window.layers.some((layer) => layer.blocks?.some((block) => block.block_id === blockId && block.host_id === host.id)));
  if (entry) {
    yield* saveAssociation({ hostId: host.id, commonDir: current.commonDir, path, sessionId: request.sessionId, windowId: entry.window_id, blockId })
      .pipe(Effect.catch((error) => Effect.sync(() => { console.error(`Worktree ${path} is available; association not saved: ${Cause.pretty(Cause.fail(error))}`); })));
  } else console.error(`Worktree ${path} is available; Rex block could not be associated, select this worktree by path next time.`);
  yield* shell(path);
});
