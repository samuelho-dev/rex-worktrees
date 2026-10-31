import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  AppError,
  CommandError,
  RequestSchema,
  ResponseSchema,
  RexWorktreesResponseSchema,
  ServerHostIdSchema,
  SessionIdSchema,
  type LaunchPlan,
  type ServerHostId,
  type SessionId,
} from "../src/contracts.ts";
import { planWorktree } from "../src/git.ts";
import { run } from "../src/process.ts";
import { sameLaunchPlan } from "../src/worktrees.ts";

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
    version: 2,
    hostId: "real-host-id",
    kind: "branch",
    repo: "/repo",
    branch: "feature",
    worktreeName: "task-name",
  };
  expect(Schema.decodeUnknownSync(RequestSchema)(request)).toMatchObject(
    request,
  );
  expect(() =>
    Schema.decodeUnknownSync(RequestSchema)({ ...request, kind: "launch" }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(RequestSchema)({ ...request, version: 1 }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(RequestSchema)({ ...request, hostId: undefined }),
  ).toThrow();
  const response = {
    version: 2,
    hostId: "real-host-id",
    kind: "branch",
    path: "/repo.worktrees/task-name",
    branch: "feature",
    existing: false,
  };
  expect(Schema.decodeUnknownSync(ResponseSchema)(response)).toMatchObject(
    response,
  );
  expect(() =>
    Schema.decodeUnknownSync(ResponseSchema)({ ...response, kind: "launch" }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ResponseSchema)({ ...response, version: 1 }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ResponseSchema)({
      ...response,
      hostId: undefined,
    }),
  ).toThrow();
});

it("native action responses preserve empty collections and detached branches without accepting malformed envelopes", () => {
  const decode = Schema.decodeUnknownSync(RexWorktreesResponseSchema);
  const empty = {
    version: 2,
    hostId: "host",
    kind: "worktrees",
    worktrees: [],
    branches: [],
  };
  expect(decode(JSON.stringify(JSON.stringify(empty)))).toEqual(empty);
  const detached = {
    ...empty,
    worktrees: [
      {
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
    decode(JSON.stringify(JSON.stringify({ ...empty, version: 1 }))),
  ).toThrow();
  expect(() =>
    decode(JSON.stringify(JSON.stringify({ ...empty, hostId: undefined }))),
  ).toThrow();
});

it("review comparison ignores JSON key order and warnings but pins host, base, root, checkout and name", () => {
  const hostId = Schema.decodeUnknownSync(ServerHostIdSchema)("host-a");
  const sessionId = Schema.decodeUnknownSync(SessionIdSchema)("session");
  const plan: LaunchPlan = {
    hostId,
    worktreeRoot: "/trees",
    input: {
      repo: "/repo",
      sessionId,
      branch: "feature/topic",
      worktreeName: "task-name",
      name: "Feature",
    },
    sessionId,
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
