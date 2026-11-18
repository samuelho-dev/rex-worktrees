import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { Cause, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolveWorktreeRoot } from "./config.ts";
import { AppError, CommandError, RexProcessSchema, RexDirectorySchema, SessionSelectionSchema, type BlockId, type CloneInput, type ClonePlan, type CloneLaunchResult, type CloneTaskRequest, type ServerHostId, type SessionId, type TaskRequest, type LaunchInput, type LaunchPlan, type LaunchResult, type Association, type JjRevision, type JjWorkspaceName, type RepositoryHead, type SessionSelection } from "./contracts.ts";
import { cloneRepository as cloneGitRepository, createPrimaryBranch, createWorktree, gitContext, listBranches, listWorktrees as listGitWorktrees, missing, origin, originDefaultHead, planWorktree, remoteBranchHead, remoteBranches, repositoryHead, safeOrigin, validCloneBranch } from "./git.ts";
import * as jj from "./jj.ts";
import { repository } from "./repositories.ts";
import { associations, rememberCloneRoot, saveAssociation } from "./state.ts";
import { openTerminal, taskContext, focus, listClients, listSessions, localDirectoryUri, localHost, localBlocks, localBlockWindow, rex } from "./rex.ts";

const fail = (message: string) => Effect.fail(new AppError({ message }));
const sameSession = (a: SessionSelection, b: SessionSelection) =>
  a.kind === b.kind && (a.kind === "existing" && b.kind === "existing" ? a.id === b.id
    : a.kind === "new" && b.kind === "new" && a.name === b.name);
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

const liveBlock = Effect.fnUntraced(function*(sessionId: SessionId, blockId: BlockId, path: string) {
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
  return cwd === path;
});

export const planLaunch = Effect.fnUntraced(function*(input: LaunchInput, expectedHostId?: ServerHostId) {
  const host = yield* localHost;
  if (expectedHostId && host.id !== expectedHostId) return yield* fail(`Wrong Rex host: expected ${expectedHostId}, got ${host.id}`);
  yield* Schema.decodeUnknownEffect(SessionSelectionSchema)(input.session);
  if (input.session.kind === "existing") {
    const sessionId = input.session.id;
    if (!(yield* listSessions).some(item => item.id === sessionId)) return yield* fail(`Rex session ${sessionId} does not exist locally`);
  }
  const clients = yield* listClients;
  if (input.clientId && !clients.some(item => item.id === input.clientId)) return yield* fail(`Rex app client ${input.clientId} is not connected locally`);
  const clientId = input.clientId ?? (clients.length === 1 ? clients[0]?.id : undefined);
  const repo = yield* repository(input.repo);
  if (repo.vcs !== input.vcs) return yield* fail("Repository backend changed since selection");
  const pathService = yield* Path.Path;
  if (input.directory !== undefined && (!pathService.isAbsolute(input.directory) || pathService.resolve(input.directory) !== input.directory || input.directory === pathService.parse(input.directory).root))
    return yield* fail("Worktree directory must be a normalized absolute directory");
  if (input.directory !== undefined && input.path !== undefined) return yield* fail("Directory cannot be combined with an existing worktree path");
  let path: string;
  let checkout: "existing" | "attach" | "create";
  let branch: string | null = null;
  let workspaceName: JjWorkspaceName | undefined;
  let base: JjRevision | undefined;
  let gitBase: RepositoryHead | undefined;
  let worktreeRoot: string | undefined;
  let detail: string | undefined;
  if (input.vcs === "git") {
    if (!!input.branch === !!input.path) return yield* fail("Select exactly one branch or existing worktree path");
    if (input.path && input.worktreeName !== undefined) return yield* fail("Worktree name only applies to a branch checkout");
    worktreeRoot = input.branch ? (input.directory ? pathService.dirname(input.directory) : yield* resolveWorktreeRoot(repo.path)) : undefined;
    if (input.branch) {
      const destination = yield* planWorktree(repo.path, input.branch, worktreeRoot, input.directory ? pathService.basename(input.directory) : input.worktreeName);
      if (input.directory && destination.path !== input.directory) return yield* fail("Branch is already checked out at a different directory");
      path = destination.path;
      branch = input.branch;
      checkout = destination.existing ? "existing" : (yield* listBranches(repo.path)).includes(branch) ? "attach" : "create";
      if (checkout === "create") gitBase = yield* repositoryHead(repo.path);
    } else {
      if (!input.path) return yield* fail("Select an existing worktree path");
      path = yield* canonical(input.path);
      const tree = (yield* listGitWorktrees(repo.path)).find(entry => entry.path === path);
      if (!tree) return yield* fail(`${path} is not a Git worktree of ${repo.path}`);
      branch = tree.branch;
      checkout = "existing";
    }
    detail = checkout === "existing" && !!input.branch
      ? `Branch ${branch} is already checked out; opening its existing worktree.`
      : checkout === "attach" ? `Branch ${branch} already exists; attaching a checkout, not creating the branch.` : undefined;
  } else {
    if (!!input.path === !!input.worktreeName || (input.path && input.revision) || (!input.path && !input.revision))
      return yield* fail("Select an existing workspace path or a new workspace name and base revision");
    if (input.path) {
      path = yield* canonical(input.path);
      const tree = (yield* jj.listWorkspaces(repo.path)).find(entry => entry.path === path && entry.present);
      if (!tree) return yield* fail(`${path} is not an available JJ workspace of ${repo.path}`);
      workspaceName = tree.name;
      checkout = "existing";
    } else {
      if (input.directory && pathService.basename(input.directory) !== input.worktreeName) return yield* fail("Workspace name must match the directory name");
      worktreeRoot = input.directory ? pathService.dirname(input.directory) : yield* resolveWorktreeRoot(repo.path);
      const planned = yield* jj.planWorkspace(repo.path, input.worktreeName!, input.revision!, worktreeRoot);
      path = planned.path;
      workspaceName = planned.workspaceName;
      base = planned.base;
      checkout = "create";
    }
  }
  let warning: string | undefined;
  if (!clientId && clients.length > 1) warning = "Multiple Rex apps are connected; select the session in the intended app";
  let target: LaunchPlan["target"];
  if (input.session.kind === "existing" && (!input.additional || input.split)) {
    const sessionId = input.session.id;
    const records = yield* associations.pipe(Effect.catch(error => Effect.sync((): Association[] => {
      warning = [warning, Cause.pretty(Cause.fail(error))].filter(Boolean).join("; ");
      return [];
    })));
    const candidates = records.filter(entry => entry.vcs === repo.vcs && entry.hostId === host.id &&
      entry.commonDir === repo.commonDir && entry.path === path && entry.sessionId === sessionId);
    const blocks = candidates.length ? yield* localBlocks(sessionId) : [];
    for (const entry of candidates) {
      if (blocks.find(block => block.block_id === entry.blockId)?.window_id !== entry.windowId) continue;
      if (yield* liveBlock(sessionId, entry.blockId, path)) {
        target = { windowId: entry.windowId, blockId: entry.blockId }; break;
      }
    }
  }
  const action: LaunchPlan["action"] = input.split && target ? "split" : target && !input.additional && !input.split ? "focus" : "new-tab";
  const nameRole: LaunchPlan["nameRole"] = action === "focus" ? "none" : action === "split" ? "pane" : "tab";
  if (nameRole !== "none" && (!input.name.trim() || input.name.startsWith("-") || /[\p{ASCII}&&\p{Cc}]/v.test(input.name)))
    return yield* fail(`Invalid Rex ${nameRole} name`);
  if (input.split && !target) detail = "No live tab for this checkout; opening a new tab instead.";
  if (input.vcs === "jj" && checkout === "create")
    detail = [detail, `Creating a JJ workspace snapshots ${repo.path}; its working-copy commit and colocated Git index intent-to-add entries may change.`].filter(Boolean).join(" ");
  const common = {
    hostId: host.id, ...(clientId ? { clientId } : {}), path,
    ...(worktreeRoot ? { worktreeRoot } : {}), action, ...(target ? { target } : {}),
    nameRole, ...(nameRole !== "none" ? { name: input.name } : {}),
    ...(detail ? { detail } : {}), ...(warning ? { warning } : {})
  };
  if (input.vcs === "git") return {
    ...common, vcs: "git" as const,
    input: { ...input, repo: repo.path, ...(input.path ? { path } : {}), ...(input.directory ? { worktreeName: pathService.basename(input.directory) } : {}) }, branch, checkout,
    ...(gitBase ? { base: gitBase } : {}),
    label: action === "focus" ? "Focus existing tab" : checkout === "create" ? "Create worktree & open" :
      checkout === "attach" ? "Attach branch & open" : action === "split" ? "Open pane" : "Open tab"
  };
  return {
    ...common, vcs: "jj" as const, checkout: checkout === "create" ? "create" as const : "existing" as const,
    input: { ...input, repo: repo.path, ...(input.path ? { path } : {}) }, workspaceName: workspaceName!,
    ...(base ? { base } : {}), label: action === "focus" ? "Focus existing tab" :
      checkout === "create" ? "Create workspace & open" : action === "split" ? "Open pane" : "Open tab"
  };
});

export const sameLaunchPlan = (a: LaunchPlan, b: LaunchPlan): boolean =>
  a.vcs === b.vcs && a.input.vcs === b.input.vcs &&
  a.hostId === b.hostId && a.worktreeRoot === b.worktreeRoot &&
  a.clientId === b.clientId &&
  a.input.repo === b.input.repo && sameSession(a.input.session, b.input.session) &&
  a.input.path === b.input.path && a.input.directory === b.input.directory && a.input.worktreeName === b.input.worktreeName &&
  a.input.name === b.input.name && a.input.clientId === b.input.clientId &&
  a.input.additional === b.input.additional && a.input.split === b.input.split &&
  a.path === b.path && a.checkout === b.checkout &&
  a.action === b.action && a.nameRole === b.nameRole && a.name === b.name &&
  a.target?.windowId === b.target?.windowId && a.target?.blockId === b.target?.blockId &&
  (a.vcs === "git" && b.vcs === "git" && a.input.vcs === "git" && b.input.vcs === "git"
    ? a.input.branch === b.input.branch && a.branch === b.branch &&
    a.base?.head === b.base?.head && a.base?.branch === b.base?.branch
    : a.vcs === "jj" && b.vcs === "jj" && a.input.vcs === "jj" && b.input.vcs === "jj" &&
    a.input.revision === b.input.revision && a.workspaceName === b.workspaceName &&
    a.base?.commitId === b.base?.commitId && a.base?.changeId === b.base?.changeId);

export const launch = Effect.fnUntraced(function*(input: LaunchInput, command: readonly string[], reviewed?: LaunchPlan, expectedHostId?: ServerHostId) {
  const pathService = yield* Path.Path;
  if (!command[0] || !pathService.isAbsolute(command[0])) return yield* fail("The task executable must be an absolute path");
  const plan = yield* planLaunch(input, expectedHostId);
  if (reviewed && !sameLaunchPlan(reviewed, plan)) return yield* fail("Launch plan changed since review; inspect the destination before submitting again");
  if (plan.action === "focus") {
    const target = plan.target;
    if (!target || plan.input.session.kind !== "existing") return yield* fail("The reviewed focus target is no longer available");
    const sessionId = plan.input.session.id;
    const warning = [plan.warning, yield* focus(sessionId, target.windowId, target.blockId, plan.clientId)].filter(Boolean).join("; ") || undefined;
    const result: LaunchResult = {
      hostId: plan.hostId, sessionId, windowId: target.windowId, blockId: target.blockId, path: plan.path,
      pending: false, action: plan.action, warning
    };
    return result;
  }
  const repo = yield* repository(plan.input.repo);
  if (repo.vcs !== plan.vcs) return yield* fail("Repository backend changed since review");
  const common = {
    repo: repo.path, path: plan.path, commonDir: repo.commonDir, session: plan.input.session, hostId: plan.hostId,
    ...taskSettings(),
    ...(plan.worktreeRoot ? { worktreeRoot: plan.worktreeRoot } : {})
  };
  const request: TaskRequest = plan.vcs === "git" ? {
    ...common, vcs: "git", ...(plan.input.branch ? { branch: plan.input.branch } : {}),
    ...(plan.input.worktreeName !== undefined ? { worktreeName: plan.input.worktreeName } : {}),
    ...(plan.base ? { base: plan.base.head } : {}),
    ...(plan.checkout !== "create" ? { checkout: plan.checkout } : {})
  } : {
    ...common, vcs: "jj", checkout: plan.checkout, workspaceName: plan.workspaceName,
    ...(plan.base ? { base: plan.base } : {})
  };
  const argv = [...command, "task", JSON.stringify(request)];
  // The task process owns creation and persists the association before starting its shell.
  const target = plan.target;
  const name = plan.name;
  if (!name) return yield* fail("The reviewed Rex tab name is no longer available");
  if (plan.action === "split" && !target) return yield* fail("The reviewed split target is no longer available");
  const created = yield* openTerminal(plan.input.session, name, plan.checkout === "existing" ? plan.path : repo.path, argv,
    plan.action === "split" ? target : undefined);
  const warning = [plan.warning, yield* focus(created.sessionId, created.windowId, created.blockId, plan.clientId)].filter(Boolean).join("; ") || undefined;
  const result: LaunchResult = {
    hostId: plan.hostId, ...created, path: plan.path,
    pending: true, action: plan.action, warning
  };
  return result;
});

const shell = Effect.fnUntraced(function*(cwd: string) {
  const path = yield* Path.Path;
  const program = process.env.SHELL || "/bin/sh";
  if (!path.isAbsolute(program)) return yield* fail("SHELL must be an absolute executable path");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(program, path.basename(program) === "sh" ? ["-i"] : ["-l", "-i"], {
    cwd, detached: false, stdin: "inherit", stdout: "inherit", stderr: "inherit"
  }));
  const code = yield* child.exitCode;
  if (code !== 0) return yield* fail(`Shell exited with status ${code}`);
}, Effect.scoped);

const taskSettings = () => ({
  ...(process.env.REX_BIN_DIR ? { rexBinDir: process.env.REX_BIN_DIR } : {}),
  ...(process.env.REX_WORKTREES_LOCAL_ENDPOINT ? { rexLocalEndpoint: process.env.REX_WORKTREES_LOCAL_ENDPOINT } : {})
});

const associateTask = Effect.fnUntraced(function*(association: Omit<Association, "windowId">) {
  const windowId = yield* localBlockWindow(association.sessionId, association.blockId);
  if (!windowId) return yield* fail("Rex task terminal is no longer placed on its requested host");
  yield* saveAssociation({ ...association, windowId });
}, effect => effect.pipe(Effect.catch(error => Effect.sync(() =>
  console.error(`Checkout is available; association not saved: ${Cause.pretty(Cause.fail(error))}`)))));

export const task = Effect.fnUntraced(function*(request: TaskRequest) {
  const { sessionId, blockId } = yield* taskContext(request.session, request, request.hostId);
  if (request.vcs === "git" && !request.branch && request.worktreeName !== undefined) return yield* fail("Worktree name only applies to a branch checkout");
  const current = yield* repository(request.repo);
  if (current.vcs !== request.vcs || current.commonDir !== request.commonDir || current.path !== request.repo) return yield* fail("Repository identity changed since launch");
  let path: string;
  if (request.vcs === "jj") {
    if (request.checkout === "create") {
      if (!request.base) return yield* fail("New JJ workspace requires a pinned base revision");
      const planned = yield* jj.planWorkspace(request.repo, request.workspaceName, request.base.commitId, request.worktreeRoot);
      if (planned.path !== request.path || planned.workspaceName !== request.workspaceName ||
        planned.base.commitId !== request.base.commitId || planned.base.changeId !== request.base.changeId)
        return yield* fail("JJ workspace destination or pinned base changed since launch");
      const created = yield* jj.createWorkspace(request.repo, request.workspaceName, request.base, request.worktreeRoot);
      if (!created.path || !created.present) return yield* fail(`JJ workspace registration has no available checkout; inspect ${request.path}`);
      path = yield* canonical(created.path);
    } else {
      if (request.base) return yield* fail("Existing JJ workspace cannot change its base revision");
      path = yield* canonical(request.path);
      const tree = (yield* jj.listWorkspaces(request.repo)).find(entry => entry.path === path && entry.name === request.workspaceName && entry.present);
      if (!tree) return yield* fail("Selected JJ workspace no longer belongs to repository");
    }
  } else if (request.branch) {
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
    const trees = yield* listGitWorktrees(request.repo);
    if (!trees.some(tree => tree.path === path)) return yield* fail("Selected worktree no longer belongs to repository");
  }
  if (path !== request.path) return yield* fail(`Worktree path changed; checkout remains at ${path}`);
  yield* associateTask({ vcs: request.vcs, hostId: request.hostId, commonDir: current.commonDir, path, sessionId, blockId });
  yield* shell(path);
});

export const cloneDestination = Effect.fnUntraced(function*(destination: string, url: string, vcs: ClonePlan["vcs"] = "git", sourceHostId?: ServerHostId) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(destination) || path.resolve(destination) !== destination || destination === path.parse(destination).root)
    return yield* fail("Clone destination must be a normalized absolute directory");
  const parts = destination.slice(path.parse(destination).root.length).split(path.sep);
  let current = path.parse(destination).root;
  for (let index = 0; index < parts.length; index++) {
    const parent = current;
    current = path.join(current, parts[index]!);
    const info = yield* Effect.catchIf(fs.lstat(current), missing, () => Effect.succeed(undefined));
    if (info?.type === "SymbolicLink") return yield* fail(`Symlinked clone destination: ${current}`);
    if (index < parts.length - 1 && info && info.type !== "Directory") return yield* fail(`Not a directory: ${current}`);
    if (index < parts.length - 1 && info && ((yield* gitContext(current)) || (yield* fs.exists(path.join(current, ".jj")))))
      return yield* fail(vcs === "git" ? `Clone destination is inside a checkout or Git metadata: ${current}` :
        `Clone destination is inside a checkout or VCS metadata: ${current}`);
    if (index === parts.length - 1 && info) {
      if (info.type !== "Directory") return yield* fail(`Clone destination already exists: ${current}`);
      const repo = yield* repository(current).pipe(Effect.catchIf(
        error => missing(error) || (Schema.is(CommandError)(error) && error.args.includes("rev-parse")),
        () => fail(`Clone destination already exists and is not a repository: ${current}`)
      ));
      if (repo.path !== current || repo.vcs !== vcs) return yield* fail(`Clone destination is not the requested ${vcs} repository: ${current}`);
      const actual = repo.vcs === "git" ? yield* origin(current) : (yield* jj.cloneSource(current, sourceHostId ?? (yield* localHost).id)).url;
      if (actual !== url) return yield* fail(`Clone destination belongs to a different origin: ${current}`);
      return repo.commonDir;
    }
    if (parent === current) return yield* fail("Invalid clone destination");
  }
  return undefined;
});

export const checkCloneParent = Effect.fnUntraced(function*(destination: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let ancestor = path.dirname(destination);
  while (!(yield* fs.lstat(ancestor).pipe(Effect.map(() => true), Effect.catchIf(missing, () => Effect.succeed(false)))))
    ancestor = path.dirname(ancestor);
  yield* Effect.tryPromise({
    try: () => access(ancestor, constants.W_OK | constants.X_OK),
    catch: cause => new AppError({ message: `Cannot create clone destination ${destination}: ${ancestor} is not writable; choose another destination or fix its permissions`, cause })
  });
});

const validateCloneDestination = Effect.fnUntraced(function*(input: CloneInput) {
  const path = yield* Path.Path;
  if (input.directory !== undefined) {
    if (!path.isAbsolute(input.directory) || path.resolve(input.directory) !== input.directory || input.directory === path.parse(input.directory).root)
      return yield* fail("Worktree directory must be a normalized absolute directory");
    if (input.checkout !== "worktree") return yield* fail("Worktree directory requires a worktree checkout");
  }
  if (input.checkout === "primary" && input.worktreeName !== undefined) return yield* fail("Primary checkout cannot have a worktree name");
  if (input.checkout === "worktree" && input.vcs === "jj" && !input.directory && !input.worktreeName)
    return yield* fail("JJ worktree checkout requires a workspace name or directory");
});

export const planClone = Effect.fnUntraced(function*(input: CloneInput, expectedHostId?: ServerHostId) {
  const host = yield* localHost;
  if (expectedHostId && host.id !== expectedHostId) return yield* fail("Wrong Rex clone host");
  if (input.vcs !== input.source.vcs) return yield* fail("Clone source backend does not match request");
  yield* validateCloneDestination(input);
  yield* Schema.decodeUnknownEffect(SessionSelectionSchema)(input.session);
  if (input.session.kind === "existing") {
    const sessionId = input.session.id;
    if (!(yield* listSessions).some(item => item.id === sessionId)) return yield* fail("Requested Rex session does not exist");
  }
  const clients = yield* listClients;
  if (input.clientId && !clients.some(item => item.id === input.clientId)) return yield* fail("Requested Rex app client is not connected");
  if (!input.name.trim() || input.name.startsWith("-") || /[\p{ASCII}&&\p{Cc}]/v.test(input.name)) return yield* fail("Invalid Rex tab name");
  if (input.vcs === "git") yield* validCloneBranch(input.branch, input.worktreeName);
  else if (input.worktreeName !== undefined && !input.worktreeName.trim()) return yield* fail("JJ workspace name cannot be blank");
  const url = yield* Effect.try({
    try: () => safeOrigin(input.source.url, input.source.sourceHostId === host.id),
    catch: () => new AppError({ message: "Clone source URL is unsafe or local to another Rex host" })
  });
  const commonDir = yield* cloneDestination(input.repo, url, input.vcs, host.id);
  if (commonDir === undefined) yield* checkCloneParent(input.repo);
  const existing = commonDir !== undefined;
  if (existing && input.checkout === "primary" && input.vcs === "git" &&
    (input.branchMode !== "existing" || (yield* repositoryHead(input.repo)).branch !== input.branch))
    return yield* fail("Existing primary checkout is not on the requested branch");
  let gitBase: string | undefined;
  let base: JjRevision | undefined;
  if (input.vcs === "git") {
    gitBase = existing && input.branchMode === "create" ? yield* originDefaultHead(input.repo) : undefined;
  } else if (input.revision !== undefined) {
    if (!/^[0-9a-f]{40,64}$/.test(input.revision)) return yield* fail("Clone base must be a full source-resolved commit ID");
    base = [input.source.revision, ...input.source.revisions.map(choice => choice.revision)]
      .find(candidate => candidate?.commitId === input.revision);
    if (!base) return yield* fail("Clone base must be resolved on the source host before transfer");
    if (existing) {
      const reached = yield* jj.resolveRevision(input.repo, base.commitId);
      if (reached.commitId !== base.commitId || reached.changeId !== base.changeId)
        return yield* fail("Selected source revision is not available at the destination");
    }
  }
  if (input.vcs === "jj" && existing && !base) base = yield* jj.resolveRevision(input.repo, "@-");
  if (input.vcs === "jj" && existing && input.checkout === "primary" && base) {
    const current = yield* jj.resolveRevision(input.repo, "@-");
    if (current.commitId !== base.commitId || current.changeId !== base.changeId)
      return yield* fail("Existing primary workspace is not based on the requested revision");
  }
  const clientId = input.clientId ?? (clients.length === 1 ? clients[0]?.id : undefined);
  const warning = !clientId && clients.length > 1 ? "Multiple Rex apps are connected; select the intended app" : undefined;
  const snapshotDetail = input.vcs === "jj" && input.checkout !== "primary" && (input.directory || input.worktreeName || existing)
    ? `JJ ${input.directory || input.worktreeName ? "workspace creation" : "new change"} snapshots the destination workspace at ${input.repo}; its working-copy commit and colocated Git index intent-to-add entries may change.`
    : undefined;
  const common = {
    hostId: host.id, ...(clientId ? { clientId } : {}),
    repo: input.repo, existing, ...(commonDir ? { commonDir } : {}),
    label: existing ? "Open existing repository" : "Clone & Open",
    detail: [`Source ${url} → ${input.repo}. Only pushed history transfers; credentials stay on this machine.`, snapshotDetail].filter(Boolean).join(" "),
    ...(warning ? { warning } : {})
  };
  if (input.vcs === "git") return {
    ...common, vcs: "git" as const,
    input: { ...input, source: { ...input.source, url } }, ...(gitBase ? { base: gitBase } : {})
  };
  return {
    ...common, vcs: "jj" as const,
    input: { ...input, source: { ...input.source, url } }, ...(base ? { base } : {})
  };
});

export const sameClonePlan = (a: ClonePlan, b: ClonePlan): boolean =>
  a.vcs === b.vcs && a.input.vcs === b.input.vcs &&
  a.hostId === b.hostId && a.clientId === b.clientId &&
  a.repo === b.repo && a.existing === b.existing && a.commonDir === b.commonDir &&
  a.input.repo === b.input.repo && sameSession(a.input.session, b.input.session) &&
  a.input.clientId === b.input.clientId && a.input.name === b.input.name &&
  a.input.worktreeName === b.input.worktreeName && a.input.directory === b.input.directory && a.input.checkout === b.input.checkout &&
  a.input.source.url === b.input.source.url && a.input.source.sourceHostId === b.input.source.sourceHostId &&
  (a.vcs === "git" && b.vcs === "git" && a.input.vcs === "git" && b.input.vcs === "git"
    ? a.base === b.base && a.input.branch === b.input.branch && a.input.branchMode === b.input.branchMode &&
    a.input.source.branch === b.input.source.branch &&
    a.input.source.branches.length === b.input.source.branches.length &&
    a.input.source.branches.every((branch, index) => branch === b.input.source.branches[index])
    : a.vcs === "jj" && b.vcs === "jj" && a.input.vcs === "jj" && b.input.vcs === "jj" &&
    a.base?.commitId === b.base?.commitId && a.base?.changeId === b.base?.changeId &&
    a.input.revision === b.input.revision &&
    a.input.source.revision?.commitId === b.input.source.revision?.commitId &&
    a.input.source.revision?.changeId === b.input.source.revision?.changeId &&
    a.input.source.revisions.length === b.input.source.revisions.length &&
    a.input.source.revisions.every((choice, index) => choice.expression === b.input.source.revisions[index]?.expression &&
      choice.revision.commitId === b.input.source.revisions[index]?.revision.commitId &&
      choice.revision.changeId === b.input.source.revisions[index]?.revision.changeId));

export const launchClone = Effect.fnUntraced(function*(input: CloneInput, command: readonly string[], reviewed?: ClonePlan, expectedHostId?: ServerHostId) {
  const path = yield* Path.Path;
  if (!command[0] || !path.isAbsolute(command[0])) return yield* fail("The task executable must be an absolute path");
  const plan = yield* planClone(input, expectedHostId);
  if (reviewed && !sameClonePlan(reviewed, plan)) return yield* fail("Clone plan changed since review; inspect before submitting again");
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) return yield* fail("Target HOME must be an absolute directory");
  const request: CloneTaskRequest = { plan, ...taskSettings() };
  const created = yield* openTerminal(plan.input.session, input.name, home, [...command, "clone-task", JSON.stringify(request)]);
  const warning = [plan.warning, yield* focus(created.sessionId, created.windowId, created.blockId, plan.clientId)].filter(Boolean).join("; ") || undefined;
  const result: CloneLaunchResult = { hostId: plan.hostId, ...created, repo: plan.repo, pending: true, ...(warning ? { warning } : {}) };
  return result;
});

// The terminal task owns clone/create so a closed popup cannot cancel the destination operation.
export const prepareCloneCheckout = Effect.fnUntraced(function*(plan: ClonePlan) {
  yield* validateCloneDestination(plan.input);
  if (plan.repo !== plan.input.repo) return yield* fail("Clone destination changed since review");
  if (plan.vcs === "git") yield* validCloneBranch(plan.input.branch, plan.input.worktreeName);
  const url = yield* Effect.try({
    try: () => safeOrigin(plan.input.source.url, plan.input.source.sourceHostId === plan.hostId),
    catch: () => new AppError({ message: "Clone source URL is unsafe or local to another Rex host" })
  });
  if (url !== plan.input.source.url || plan.input.vcs !== plan.vcs) return yield* fail("Clone source changed since review");
  const observed = yield* cloneDestination(plan.repo, url, plan.vcs, plan.hostId);
  if (observed !== plan.commonDir || (observed !== undefined) !== plan.existing)
    return yield* fail("Clone destination identity changed since review");
  if (plan.vcs === "git" && plan.existing && plan.input.branchMode === "create" &&
    (!plan.base || plan.base !== (yield* originDefaultHead(plan.repo))))
    return yield* fail("Origin default branch changed since review");
  if (plan.vcs === "jj" && plan.existing && plan.base) {
    const reached = yield* jj.resolveRevision(plan.repo, plan.base.commitId);
    if (reached.commitId !== plan.base.commitId || reached.changeId !== plan.base.changeId)
      return yield* fail("JJ clone base changed since review");
  }
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  if (!plan.existing) {
    const parent = pathService.dirname(plan.repo);
    yield* fs.makeDirectory(parent, { recursive: true });
    if ((yield* cloneDestination(plan.repo, url, plan.vcs, plan.hostId)) !== undefined) return yield* fail("Clone target appeared since launch; destination left untouched");
    if ((yield* fs.realPath(parent)) !== parent) return yield* fail("Clone parent changed to a symlink");
    // ponytail: Exclusive mkdir reserves the name; a failed native clone retains it for inspection.
    yield* fs.makeDirectory(plan.repo);
    if ((yield* fs.realPath(parent)) !== parent || (yield* fs.realPath(plan.repo)) !== plan.repo)
      return yield* fail(`Clone path changed; reserved destination retained at ${plan.repo}`);
    if (plan.vcs === "git") yield* cloneGitRepository(url, plan.repo, plan.input.checkout === "primary" && plan.input.branchMode === "existing" ? plan.input.branch : undefined);
    else yield* jj.cloneRepository(url, plan.repo);
  }
  const repo = yield* repository(plan.repo);
  if (repo.path !== plan.repo || repo.vcs !== plan.vcs || (plan.existing && repo.commonDir !== plan.commonDir))
    return yield* fail(`Clone repository changed; retained at ${plan.repo}`);
  const actual = repo.vcs === "git" ? yield* origin(repo.path) : (yield* jj.cloneSource(repo.path, plan.hostId)).url;
  if (actual !== url) return yield* fail(`Clone origin changed; retained at ${plan.repo}`);
  if (plan.vcs === "jj") {
    const base = plan.base ?? (yield* jj.resolveRevision(repo.path, "@-"));
    let cwd: string;
    const workspaceName = plan.input.directory ? pathService.basename(plan.input.directory) : plan.input.worktreeName;
    const worktreeRoot = plan.input.directory ? pathService.dirname(plan.input.directory) : workspaceName ? yield* resolveWorktreeRoot(repo.path) : undefined;
    if (plan.input.checkout === "primary" && plan.existing) {
      const current = yield* jj.resolveRevision(repo.path, "@-");
      if (current.commitId !== base.commitId || current.changeId !== base.changeId)
        return yield* fail("Existing primary workspace changed since review");
      cwd = repo.path;
    } else if (workspaceName) {
      const planned = yield* jj.planWorkspace(repo.path, workspaceName, base.commitId, worktreeRoot);
      if (planned.base.commitId !== base.commitId || planned.base.changeId !== base.changeId || (plan.input.directory && planned.path !== plan.input.directory))
        return yield* fail(`JJ clone base or directory is unavailable; clone retained at ${plan.repo}`);
      const created = yield* jj.createWorkspace(repo.path, planned.workspaceName, base, worktreeRoot);
      if (!created.path || !created.present || created.path !== planned.path)
        return yield* fail(`JJ workspace registration changed; clone retained at ${plan.repo}`);
      cwd = created.path;
    } else if (plan.existing || plan.input.revision) {
      const created = yield* jj.newChange(repo.path, base);
      if (!created.path || !created.present || created.path !== repo.path)
        return yield* fail(`JJ default workspace changed; clone retained at ${plan.repo}`);
      cwd = created.path;
    } else {
      cwd = repo.path; // Native jj git clone already creates the default fresh change.
    }
    return { repo, cwd: yield* fs.realPath(cwd) };
  }
  const local = yield* listBranches(repo.path);
  const remote = yield* remoteBranches(repo.path);
  const { branch, branchMode } = plan.input;
  if (plan.input.checkout === "primary") {
    if (plan.existing) {
      if (branchMode !== "existing" || (yield* repositoryHead(repo.path)).branch !== branch)
        return yield* fail("Existing primary checkout is not on the requested branch");
    } else if (branchMode === "create") {
      if (local.includes(branch) || remote.includes(branch)) return yield* fail(`Branch ${branch} already exists; clone retained at ${plan.repo}`);
      yield* createPrimaryBranch(repo.path, branch);
    } else if ((yield* repositoryHead(repo.path)).branch !== branch) {
      return yield* fail(`Cloned primary checkout is not on ${branch}; clone retained at ${plan.repo}`);
    }
    return { repo, cwd: yield* fs.realPath(repo.path) };
  }
  const worktreeRoot = plan.input.directory ? pathService.dirname(plan.input.directory) : yield* resolveWorktreeRoot(repo.path);
  const worktreeName = plan.input.directory ? pathService.basename(plan.input.directory) : plan.input.worktreeName;
  let cwd: string;
  if (branchMode === "existing") {
    if (!local.includes(branch) && !remote.includes(branch))
      return yield* fail(`Branch ${branch} was not pushed to origin; clone retained at ${plan.repo}`);
    const planned = yield* planWorktree(repo.path, branch, worktreeRoot, worktreeName);
    if (plan.input.directory && planned.path !== plan.input.directory) return yield* fail("Branch is already checked out at a different directory");
    if (local.includes(branch)) {
      cwd = planned.existing ? planned.path : (yield* createWorktree(repo.path, branch, { attachOnly: true, worktreeRoot, worktreeName })).path;
    } else {
      cwd = (yield* createWorktree(repo.path, branch, { startPoint: yield* remoteBranchHead(repo.path, branch), worktreeRoot, worktreeName })).path;
    }
  } else {
    if (local.includes(branch) || remote.includes(branch)) return yield* fail(`Branch ${branch} already exists; clone retained at ${plan.repo}`);
    const base = plan.existing ? plan.base : (yield* repositoryHead(repo.path)).head;
    if (!base) return yield* fail("Origin default branch changed since review");
    cwd = (yield* createWorktree(repo.path, branch, { startPoint: base, worktreeRoot, worktreeName })).path;
  }
  return { repo, cwd: yield* fs.realPath(cwd) };
});
export const cloneTask = Effect.fnUntraced(function*(request: CloneTaskRequest) {
  const { plan } = request;
  const { sessionId, blockId } = yield* taskContext(plan.input.session, request, plan.hostId);
  if (!sameClonePlan(plan, yield* planClone(plan.input, plan.hostId))) return yield* fail("Clone target changed since launch; destination left untouched");
  const { repo, cwd } = yield* prepareCloneCheckout(plan);
  yield* rememberCloneRoot((yield* Path.Path).dirname(repo.path)).pipe(Effect.catch(error =>
    Effect.sync(() => console.error(`Checkout ${cwd} is available; clone parent not remembered: ${Cause.pretty(Cause.fail(error))}`))));
  yield* associateTask({ vcs: repo.vcs, hostId: plan.hostId, commonDir: repo.commonDir, path: cwd, sessionId, blockId });
  yield* shell(cwd);
});
