import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError, Result, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  AppError,
  CommandError,
  CloneTaskRequestSchema,
  RequestSchema,
  ResponseSchema,
  RexWorktreesResponseSchema,
  JjCommitIdSchema,
  JjChangeIdSchema,
  JjWorkspaceNameSchema,
  ServerHostIdSchema,
  SessionIdSchema,
  type ClonePlan,
  type LaunchPlan,
  type ServerHostId,
  type SessionId,
} from "../src/contracts.ts";
import { hostRequest } from "../src/host.ts";
import { localHost } from "../src/rex.ts";
import { planWorktree } from "../src/git.ts";
import { run } from "../src/process.ts";
import { sameClonePlan, sameLaunchPlan } from "../src/worktrees.ts";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Channels<F> = F extends (
  ...args: never[]
) => Effect.Effect<infer _A, infer E, infer R>
  ? [E, R]
  : never;
// Check actual exported effects, not an asserted stand-in or a manually widened annotation.
export type InferredEffectChannels = [
  Assert<
    Equal<
      Channels<typeof run>,
      [
        CommandError | PlatformError.PlatformError,
        ChildProcessSpawner.ChildProcessSpawner,
      ]
    >
  >,
  Assert<
    Equal<
      Channels<typeof planWorktree>,
      [
        AppError | CommandError | PlatformError.PlatformError,
        (
          | FileSystem.FileSystem
          | Path.Path
          | ChildProcessSpawner.ChildProcessSpawner
        ),
      ]
    >
  >,
];
// A raw string or a server host ID must not be interchangeable with a Rex session ID.
export type BrandedIdentitySafety = [
  Assert<string extends SessionId ? false : true>,
  Assert<ServerHostId extends SessionId ? false : true>,
];
it("every request and reply requires protocol version and destination identity", () => {
  const request = {
    version: 4,
    hostId: "real-host-id",
    kind: "project",
    path: "/repo",
  };
  expect(Schema.decodeUnknownSync(RequestSchema)(request)).toMatchObject(
    request,
  );
  expect(() =>
    Schema.decodeUnknownSync(RequestSchema)({ ...request, kind: "launch" }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(RequestSchema)({ ...request, version: 3 }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(RequestSchema)({ ...request, hostId: undefined }),
  ).toThrow();
  const response = {
    version: 4,
    hostId: "real-host-id",
    kind: "project-missing",
    path: "/repo",
  };
  expect(Schema.decodeUnknownSync(ResponseSchema)(response)).toMatchObject(
    response,
  );
  expect(() =>
    Schema.decodeUnknownSync(ResponseSchema)({ ...response, kind: "launch" }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ResponseSchema)({ ...response, version: 3 }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ResponseSchema)({
      ...response,
      hostId: undefined,
    }),
  ).toThrow();
});
it("discovery requires a destination-local clone root", () => {
  const response = { version: 4, hostId: "fixture-host", kind: "discover", sessions: [], clients: [], projects: [], roots: [], cloneRoot: "/home/fixture" };
  expect(Schema.decodeUnknownSync(ResponseSchema)(response)).toMatchObject(response);
  expect(() => Schema.decodeUnknownSync(ResponseSchema)({ ...response, cloneRoot: undefined })).toThrow();
});


it("native action responses preserve empty collections and detached branches without accepting malformed envelopes", () => {
  const decode = Schema.decodeUnknownSync(RexWorktreesResponseSchema);
  const empty = {
    version: 4,
    hostId: "host",
    kind: "worktrees",
    repository: { vcs: "git", path: "/repo", commonDir: "/repo/.git", name: "repo" },
    worktrees: [],
    branches: [],
    revisions: [],
  };
  expect(decode(JSON.stringify(JSON.stringify(empty)))).toEqual(empty);
  const detached = {
    ...empty,
    worktrees: [
      {
        vcs: "git",
        path: "/repo",
        branch: null,
        head: "abc",
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
  };
  expect(decode(JSON.stringify(JSON.stringify(detached)))).toEqual(detached);
  expect(() => decode(JSON.stringify(empty))).toThrow();
  expect(() =>
    decode(JSON.stringify(JSON.stringify({ ...empty, version: 3 }))),
  ).toThrow();
  expect(() =>
    decode(JSON.stringify(JSON.stringify({ ...empty, hostId: undefined }))),
  ).toThrow();
});

it("review comparison ignores JSON key order and warnings but pins host, base, root, checkout and name", () => {
  const hostId = Schema.decodeUnknownSync(ServerHostIdSchema)("host-a");
  const sessionId = Schema.decodeUnknownSync(SessionIdSchema)("session");
  const plan: LaunchPlan = {
    vcs: "git",
    hostId,
    worktreeRoot: "/trees",
    input: {
      vcs: "git",
      repo: "/repo",
      session: { kind: "existing", id: sessionId },
      branch: "feature/topic",
      worktreeName: "task-name",
      name: "Feature",
    },
    path: "/trees/task-name",
    branch: "feature/topic",
    checkout: "create",
    base: { branch: "main", head: "abc" },
    action: "new-tab",
    nameRole: "tab",
    name: "Feature",
    label: "Create worktree & open",
  };
  const { input, ...rest } = plan;
  const reordered = {
    ...rest,
    input,
    warning: "Could not inspect associations",
  };
  expect(sameLaunchPlan(plan, reordered)).toBe(true);
  expect(
    sameLaunchPlan(plan, {
      ...plan,
      hostId: Schema.decodeUnknownSync(ServerHostIdSchema)("host-b"),
    }),
  ).toBe(false);
  expect(sameLaunchPlan(plan, { ...plan, worktreeRoot: "/other" })).toBe(false);
  expect(
    sameLaunchPlan(plan, {
      ...plan,
      input: { ...plan.input, worktreeName: "other" },
    }),
  ).toBe(false);
  expect(
    sameLaunchPlan(plan, { ...plan, base: { branch: "main", head: "def" } }),
  ).toBe(false);
  expect(sameLaunchPlan(plan, { ...plan, checkout: "existing" })).toBe(false);
});

it("clone protocol preserves separate source, review, launch and task identities", () => {
  const hostId = Schema.decodeUnknownSync(ServerHostIdSchema)("target");
  const sessionId = Schema.decodeUnknownSync(SessionIdSchema)("session");
  const plan: ClonePlan = {
    vcs: "git", hostId, repo: "/target/repo", existing: false, label: "Clone & Open",
    input: {
      vcs: "git", source: { vcs: "git", sourceHostId: Schema.decodeUnknownSync(ServerHostIdSchema)("source"), url: "git@example.org:org/repo.git", branches: ["main", "topic"], branch: "main" },
      repo: "/target/repo", session: { kind: "existing", id: sessionId }, name: "Task", branch: "topic", branchMode: "existing"
    }
  };
  const request = { version: 4, hostId, kind: "clone-launch", input: plan.input, reviewed: plan };
  expect(Schema.decodeUnknownSync(RequestSchema)(request)).toMatchObject(request);
  expect(Schema.decodeUnknownSync(CloneTaskRequestSchema)({ plan, sessionId })).toMatchObject({ plan, sessionId });
  expect(Schema.decodeUnknownSync(ResponseSchema)({
    version: 4, hostId, kind: "clone-launch",
    result: { hostId, sessionId, windowId: "window", blockId: "block", repo: plan.repo, pending: true }
  }).kind).toBe("clone-launch");
  expect(() => Schema.decodeUnknownSync(RequestSchema)({ ...request, reviewed: undefined })).toThrow();
  expect(() => Schema.decodeUnknownSync(ResponseSchema)({
    version: 4, hostId, kind: "clone-launch",
    result: { hostId, sessionId, windowId: "window", blockId: "block", path: "/fabricated", pending: true }
  })).toThrow();
  expect(sameClonePlan(plan, { ...plan, warning: "Informational warning" })).toBe(true);
  expect(sameClonePlan(plan, { ...plan, input: { ...plan.input, branchMode: "create" } })).toBe(false);
  expect(sameClonePlan(plan, { ...plan, input: { ...plan.input, source: { ...plan.input.source, sourceHostId: hostId } } })).toBe(false);
  expect(sameClonePlan(plan, { ...plan, repo: "/other" })).toBe(false);
  expect(sameClonePlan({ ...plan, existing: true, commonDir: "/target/repo/.git", base: "abc" },
    { ...plan, existing: true, commonDir: "/other/.git", base: "abc" })).toBe(false);
  expect(sameClonePlan({ ...plan, existing: true, commonDir: "/target/repo/.git", base: "abc" },
    { ...plan, existing: true, commonDir: "/target/repo/.git", base: "def" })).toBe(false);
});

it("JJ review and clone pin source workspace and full base identity", () => {
  const hostId = Schema.decodeUnknownSync(ServerHostIdSchema)("destination");
  const sessionId = Schema.decodeUnknownSync(SessionIdSchema)("session");
  const revision = {
    commitId: Schema.decodeUnknownSync(JjCommitIdSchema)("a".repeat(40)),
    changeId: Schema.decodeUnknownSync(JjChangeIdSchema)("b".repeat(32)), description: "base"
  };
  const plan: LaunchPlan = {
    vcs: "jj", hostId, input: {
      vcs: "jj", repo: "/source-workspace", session: { kind: "existing", id: sessionId },
      name: "Task", worktreeName: "task", revision: "@-"
    },
    path: "/trees/task", checkout: "create", workspaceName: Schema.decodeUnknownSync(JjWorkspaceNameSchema)("task"),
    base: revision, action: "new-tab", nameRole: "tab", name: "Task", label: "Create workspace & open"
  };
  expect(sameLaunchPlan(plan, { ...plan, warning: "Another warning" })).toBe(true);
  expect(sameLaunchPlan(plan, { ...plan, input: { ...plan.input, repo: "/another-workspace" } })).toBe(false);
  expect(sameLaunchPlan(plan, { ...plan, base: { ...revision, commitId: Schema.decodeUnknownSync(JjCommitIdSchema)("c".repeat(40)) } })).toBe(false);
  expect(sameLaunchPlan(plan, { ...plan, workspaceName: Schema.decodeUnknownSync(JjWorkspaceNameSchema)("other") })).toBe(false);
  const source = {
    vcs: "jj" as const, url: "ssh://host/project", sourceHostId: hostId,
    revisions: [{ expression: "@-", label: "base", revision }], revision
  };
  const clone: ClonePlan = {
    vcs: "jj", hostId, repo: "/clone", existing: false, label: "Clone & Open",
    input: { vcs: "jj", source, repo: "/clone", session: { kind: "existing", id: sessionId }, name: "Task", revision: revision.commitId }, base: revision
  };
  expect(Schema.decodeUnknownSync(CloneTaskRequestSchema)({ plan: clone, sessionId })).toMatchObject({ plan: clone, sessionId });
  expect(sameClonePlan(clone, { ...clone, base: { ...revision, changeId: Schema.decodeUnknownSync(JjChangeIdSchema)("c".repeat(32)) } })).toBe(false);
  expect(sameClonePlan(clone, { ...clone, input: { ...clone.input, revision: undefined } })).toBe(false);
  const response = { version: 4, hostId, kind: "revision", revision };
  expect(Schema.decodeUnknownSync(ResponseSchema)(response)).toMatchObject(response);
  expect(Schema.decodeUnknownSync(RequestSchema)({ version: 4, hostId, kind: "revision", repo: "/source-workspace", revision: "@-" }).kind).toBe("revision");
  expect(() => Schema.decodeUnknownSync(RequestSchema)({ version: 3, hostId, kind: "revision", repo: "/source-workspace", revision: "@-" })).toThrow();
});

it.live("a real missing destination survives host-request and Rex's nested response envelope", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "rex-project-missing-")));
    try {
      const available = yield* Effect.result(localHost);
      // Rex is optional in CI; when present this checks the real local host-request path.
      if (Result.isFailure(available)) return;
      const path = join(root, "missing");
      const request = { version: 4, hostId: available.success.id, kind: "project", path };
      const reply = yield* hostRequest(JSON.stringify(request), ["/usr/bin/false"]);
      expect(reply).toEqual({ version: 4, hostId: available.success.id, kind: "project-missing", path });
      expect(Schema.decodeUnknownSync(RexWorktreesResponseSchema)(JSON.stringify(JSON.stringify(reply)))).toEqual(reply);
      const config = join(root, "rex-worktrees");
      yield* Effect.promise(() => mkdir(config));
      yield* Effect.promise(() => writeFile(join(config, "config.json"), "invalid project configuration"));
      const previousConfig = process.env.XDG_CONFIG_HOME;
      try {
        process.env.XDG_CONFIG_HOME = root;
        const sessionsRequest = { version: 4, hostId: available.success.id, kind: "sessions" };
        const sessions = yield* hostRequest(JSON.stringify(sessionsRequest), ["/usr/bin/false"]);
        expect(sessions.kind).toBe("sessions");
        expect(Schema.decodeUnknownSync(RexWorktreesResponseSchema)(JSON.stringify(JSON.stringify(sessions)))).toEqual(sessions);
        const wrongHost = yield* Effect.flip(hostRequest(JSON.stringify({ ...sessionsRequest, hostId: "wrong-host" }), ["/usr/bin/false"]));
        expect(Schema.is(AppError)(wrongHost) && wrongHost.message).toContain("Wrong Rex host");
      } finally {
        if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfig;
      }
    } finally {
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(BunServices.layer))
);
