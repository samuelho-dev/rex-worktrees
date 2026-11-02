import { Effect, FileSystem, Path, Schema } from "effect";
import { loadConfig, resolveCloneRoot, resolveWorktreeRoot } from "./config.ts";
import { cloneSource as gitCloneSource, listBranches, listWorktrees as listGitWorktrees, missing, notRepository, planWorktree } from "./git.ts";
import { repository, project, discoverProjects } from "./repositories.ts";
import * as jj from "./jj.ts";
import { AppError, RequestSchema, type Request, type RequestIdentity, type Response } from "./contracts.ts";
import { listClients, listSessions, localHost } from "./rex.ts";
import { launch, launchClone, planClone, planLaunch } from "./worktrees.ts";

export const dispatchHost = Effect.fnUntraced(function*(request: Request, command: readonly string[]) {
  const host = yield* localHost;
  if (host.id !== request.hostId) return yield* Effect.fail(new AppError({ message: `Wrong Rex host: expected ${request.hostId}, got ${host.id}` }));
  const path = yield* Path.Path;
  const paths = request.kind === "discover" ? (request.context ? [request.context] : [])
    : request.kind === "project" ? [request.path]
      : request.kind === "clone-plan" || request.kind === "clone-launch" ? [request.input.repo]
        : request.kind === "plan" || request.kind === "launch" ? [request.input.repo, ...(request.input.path ? [request.input.path] : [])]
          : [request.repo];
  if (paths.some(value => !path.isAbsolute(value))) return yield* Effect.fail(new AppError({ message: "Destination repository and worktree paths must be absolute" }));
  const identity: RequestIdentity = { version: 3, hostId: host.id };
  let result: Response;
  switch (request.kind) {
    case "discover": {
      const config = yield* loadConfig;
      const checkoutEffect = request.context ? Effect.catchIf(
        Effect.catchIf(repository(request.context), (error) => missing(error), () => Effect.succeed(undefined)),
        (error) => notRepository(error),
        () => Effect.succeed(undefined)
      ) : Effect.succeed(undefined);
      const { checkout, sessions, clients, projects } = yield* Effect.all({
        checkout: checkoutEffect,
        sessions: listSessions,
        clients: listClients,
        projects: discoverProjects(config.roots, config.projects, request.context)
      }, { concurrency: 4 });
      result = {
        ...identity, kind: "discover", sessions, clients, projects, roots: config.roots,
        cloneRoot: yield* resolveCloneRoot(config.roots, projects), ...(checkout ? { checkout } : {})
      };
      break;
    }
    case "project": {
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(request.path).pipe(Effect.catchIf(missing, () => Effect.succeed(undefined)));
      if (!info) {
        result = { ...identity, kind: "project-missing", path: request.path };
        break;
      }
      const checkout = yield* repository(request.path);
      const canonical = yield* project(request.path);
      result = {
        ...identity, kind: "project", project: canonical, checkout,
        worktrees: canonical.vcs === "git" ? yield* listGitWorktrees(canonical.path) : yield* jj.listWorkspaces(canonical.path),
        branches: canonical.vcs === "git" ? yield* listBranches(canonical.path) : [],
        revisions: canonical.vcs === "jj" ? yield* jj.listRevisions(canonical.path) : []
      };
      break;
    }
    case "clone-source": {
      const repo = yield* repository(request.repo);
      result = {
        ...identity, kind: "clone-source", source: repo.vcs === "git"
          ? yield* gitCloneSource(repo.path, host.id) : yield* jj.cloneSource(repo.path, host.id)
      };
      break;
    }
    case "worktrees": {
      const repo = yield* repository(request.repo);
      result = {
        ...identity, kind: "worktrees", repository: repo,
        worktrees: repo.vcs === "git" ? yield* listGitWorktrees(repo.path) : yield* jj.listWorkspaces(repo.path),
        branches: repo.vcs === "git" ? yield* listBranches(repo.path) : [],
        revisions: repo.vcs === "jj" ? yield* jj.listRevisions(repo.path) : []
      };
      break;
    }
    case "revision": {
      const repo = yield* repository(request.repo);
      if (repo.vcs !== "jj") return yield* Effect.fail(new AppError({ message: "Base revision requires a JJ repository" }));
      result = { ...identity, kind: "revision", revision: yield* jj.resolveRevision(repo.path, request.revision) };
      break;
    }
    case "branch": {
      const repo = yield* repository(request.repo);
      if (repo.vcs !== "git") return yield* Effect.fail(new AppError({ message: "Branch checkout requires a Git repository" }));
      const planned = yield* planWorktree(repo.path, request.branch, yield* resolveWorktreeRoot(repo.path), request.worktreeName);
      result = { ...identity, kind: "branch", path: planned.path, branch: planned.branch, existing: planned.existing };
      break;
    }
    case "plan": result = { ...identity, kind: "plan", plan: yield* planLaunch(request.input, host.id) }; break;
    case "clone-plan": result = { ...identity, kind: "clone-plan", plan: yield* planClone(request.input, host.id) }; break;
    case "clone-launch": result = { ...identity, kind: "clone-launch", result: yield* launchClone(request.input, command, request.reviewed, host.id) }; break;
    case "launch": result = { ...identity, kind: "launch", result: yield* launch(request.input, command, request.reviewed, host.id) }; break;
  }
  return result;
});

export const hostRequest = Effect.fnUntraced(function*(raw: string, command: readonly string[]) {
  const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RequestSchema))(raw);
  return yield* dispatchHost(request, command);
});
