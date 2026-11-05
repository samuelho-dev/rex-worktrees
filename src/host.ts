import { Effect, FileSystem, Path, Schema } from "effect";
import { loadConfig, resolveCloneRoot } from "./config.ts";
import { cloneSource as gitCloneSource, listBranches, listWorktrees as listGitWorktrees, missing, notRepository } from "./git.ts";
import { repository, project, discoverProjects } from "./repositories.ts";
import * as jj from "./jj.ts";
import { AppError, RequestSchema, type Request, type RequestIdentity, type Response } from "./contracts.ts";
import { listClients, listSessions, localHost, withLocalIdentity } from "./rex.ts";
import { launch, launchClone, planClone, planLaunch } from "./worktrees.ts";

export const dispatchHost = Effect.fnUntraced(function*(request: Request, command: readonly string[]) {
  const host = yield* localHost;
  if (host.id !== request.hostId) return yield* Effect.fail(new AppError({ message: `Wrong Rex host: expected ${request.hostId}, got ${host.id}` }));
  const path = yield* Path.Path;
  const paths = request.kind === "sessions" ? [] : request.kind === "discover" ? (request.context ? [request.context] : [])
    : request.kind === "project" ? [request.path]
      : request.kind === "clone-plan" || request.kind === "clone-launch" ? [request.input.repo]
        : request.kind === "plan" || request.kind === "launch" ? [request.input.repo, ...(request.input.path ? [request.input.path] : [])]
          : [request.repo];
  if (paths.some(value => !path.isAbsolute(value))) return yield* Effect.fail(new AppError({ message: "Destination repository and worktree paths must be absolute" }));
  const identity: RequestIdentity = { version: 4, hostId: host.id };
  let result: Response;
  switch (request.kind) {
    case "sessions": {
      const found = yield* Effect.all({ sessions: listSessions, clients: listClients }, { concurrency: 2 });
      result = { ...identity, kind: "sessions", ...found };
      break;
    }
    case "discover": {
      const config = yield* loadConfig;
      const checkoutEffect = request.context ? repository(request.context).pipe(
        Effect.catchIf(error => missing(error) || notRepository(error), () => Effect.succeed(undefined))
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
      const inventory = yield* Effect.all({
        worktrees: canonical.vcs === "git" ? listGitWorktrees(canonical.path) : jj.listWorkspaces(canonical.path),
        branches: canonical.vcs === "git" ? listBranches(canonical.path) : Effect.succeed([]),
        revisions: canonical.vcs === "jj" ? jj.listRevisions(canonical.path) : Effect.succeed([])
      }, { concurrency: 4 });
      result = {
        ...identity, kind: "project", project: canonical, checkout,
        ...inventory
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
      const inventory = yield* Effect.all({
        worktrees: repo.vcs === "git" ? listGitWorktrees(repo.path) : jj.listWorkspaces(repo.path),
        branches: repo.vcs === "git" ? listBranches(repo.path) : Effect.succeed([]),
        revisions: repo.vcs === "jj" ? jj.listRevisions(repo.path) : Effect.succeed([])
      }, { concurrency: 4 });
      result = {
        ...identity, kind: "worktrees", repository: repo,
        ...inventory
      };
      break;
    }
    case "revision": {
      const repo = yield* repository(request.repo);
      if (repo.vcs !== "jj") return yield* Effect.fail(new AppError({ message: "Base revision requires a JJ repository" }));
      result = { ...identity, kind: "revision", revision: yield* jj.resolveRevision(repo.path, request.revision) };
      break;
    }
    case "plan": result = { ...identity, kind: "plan", plan: yield* planLaunch(request.input, host.id) }; break;
    case "clone-plan": result = { ...identity, kind: "clone-plan", plan: yield* planClone(request.input, host.id) }; break;
    case "clone-launch": result = { ...identity, kind: "clone-launch", result: yield* launchClone(request.input, command, request.reviewed, host.id) }; break;
    case "launch": result = { ...identity, kind: "launch", result: yield* launch(request.input, command, request.reviewed, host.id) }; break;
  }
  return result;
}, withLocalIdentity, jj.withToolValidation);

export const hostRequest = Effect.fnUntraced(function*(raw: string, command: readonly string[]) {
  const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RequestSchema))(raw);
  return yield* dispatchHost(request, command);
});
