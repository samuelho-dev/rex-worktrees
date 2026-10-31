import { Effect, Path, Schema } from "effect";
import { loadConfig, resolveWorktreeRoot } from "./config.ts";
import { discoverProjects, listBranches, listWorktrees, missing, notRepository, planWorktree, project, repository } from "./git.ts";
import { AppError, RequestSchema, type Request, type RequestIdentity, type Response } from "./contracts.ts";
import { listClients, listSessions, localHost } from "./rex.ts";
import { launch, planLaunch } from "./worktrees.ts";

export const dispatchHost = Effect.fnUntraced(function*(request: Request, command: readonly string[]) {
  const host = yield* localHost;
  if (host.id !== request.hostId) return yield* Effect.fail(new AppError({ message: `Wrong Rex host: expected ${request.hostId}, got ${host.id}` }));
  const path = yield* Path.Path;
  const paths = request.kind === "discover" ? (request.context ? [request.context] : [])
    : request.kind === "project" ? [request.path]
    : request.kind === "plan" || request.kind === "launch" ? [request.input.repo, ...(request.input.path ? [request.input.path] : [])]
    : [request.repo];
  if (paths.some(value => !path.isAbsolute(value))) return yield* Effect.fail(new AppError({ message: "Destination repository and worktree paths must be absolute" }));
  const identity: RequestIdentity = { version: 2, hostId: host.id };
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
      result = { ...identity, kind: "discover", sessions, clients, projects, ...(checkout ? { checkout } : {}) };
      break;
    }
    case "project": {
      const checkout = yield* repository(request.path);
      const canonical = yield* project(request.path);
      result = { ...identity, kind: "project", project: canonical, checkout, worktrees: yield* listWorktrees(canonical.path), branches: yield* listBranches(canonical.path) };
      break;
    }
    case "worktrees": result = { ...identity, kind: "worktrees", worktrees: yield* listWorktrees(request.repo), branches: yield* listBranches(request.repo) }; break;
    case "branch": {
      const planned = yield* planWorktree(request.repo, request.branch, yield* resolveWorktreeRoot(request.repo), request.worktreeName);
      result = { ...identity, kind: "branch", path: planned.path, branch: planned.branch, existing: planned.existing };
      break;
    }
    case "plan": result = { ...identity, kind: "plan", plan: yield* planLaunch(request.input, host.id) }; break;
    case "launch": result = { ...identity, kind: "launch", result: yield* launch(request.input, command, request.reviewed, host.id) }; break;
  }
  return result;
});

export const hostRequest = Effect.fnUntraced(function*(raw: string, command: readonly string[]) {
  const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RequestSchema))(raw);
  return yield* dispatchHost(request, command);
});
