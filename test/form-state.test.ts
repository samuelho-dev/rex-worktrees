import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  ClientIdSchema,
  DestinationHostSchema,
  SessionIdSchema,
  type Draft,
} from "../src/contracts.ts";
import {
  changeDestination,
  changeMachine,
  changeProject,
  changeProjectChoice,
  generatedName,
  inputFor,
  resolveBranch,
  selectWorktree,
  typeWorktreeName,
} from "../src/ui.ts";

const local = Schema.decodeUnknownSync(DestinationHostSchema)({
  key: "local",
  selector: "",
  label: "This Mac",
  local: true,
  hostId: "host-local",
});
const remote = Schema.decodeUnknownSync(DestinationHostSchema)({
  key: "host:remote",
  selector: "Homelab",
  label: "Homelab",
  local: false,
  hostId: "host-remote",
});
const first = {
  path: "/projects/alpha",
  commonDir: "/git/alpha",
  name: "alpha",
};
const alias = {
  path: "/projects/alpha.other",
  commonDir: "/git/alpha",
  name: "alpha",
};
const other = { path: "/projects/beta", commonDir: "/git/beta", name: "beta" };
const projectChoice = {
  name: "alpha",
  source: { machineKey: local.key, hostId: local.hostId, repository: first },
};
const sessionId = Schema.decodeUnknownSync(SessionIdSchema)("session-local");
const clientId = Schema.decodeUnknownSync(ClientIdSchema)("client-local");

const ready = (): Draft => ({
  machine: local,
  host: local,
  projectChoice,
  project: first,
  sessionId,
  clientId,
  mode: "split",
});

it("logical project survives machine failure but old physical target cannot launch", () => {
  const draft = selectWorktree(ready(), {
    path: first.path,
    branch: "main",
    head: "abc",
    bare: false,
    locked: false,
    prunable: false,
  });
  const changed = changeMachine(draft, remote);
  expect(changed).toEqual({ machine: remote, projectChoice, mode: "split" });
  expect(inputFor(changed)).toBeUndefined();
  expect(
    inputFor({
      ...changed,
      project: other,
      destination: { branch: "feature", label: "feature" },
      sessionId,
    }),
  ).toBeUndefined();
  expect(changeMachine(draft, local)).toEqual(draft);
});

it("project choice invalidates checkout and branch, but same-host binding retains session", () => {
  const draft = resolveBranch(
    { ...ready(), worktreeName: "task-alpha" },
    "feature",
    "/projects/alpha.worktrees/task-alpha",
    false,
  );
  const changed = changeProjectChoice(draft, { name: "beta" });
  expect(changed.project).toBeUndefined();
  expect(changed.destination).toBeUndefined();
  expect(changed.worktreeName).toBeUndefined();
  expect(changed.sessionId).toBe("session-local");
  expect(changeProject(draft, alias).destination).toEqual(draft.destination);
  expect(changeProject(draft, other).destination).toBeUndefined();
  expect(inputFor(changed)).toBeUndefined();
});

it("directory name and Git branch remain independent, while occupied branch uses actual checkout", () => {
  const named = resolveBranch(
    typeWorktreeName(ready(), "task-name"),
    "feature/topic",
    "/projects/alpha.worktrees/task-name",
    false,
  );
  expect(inputFor(named)).toMatchObject({
    branch: "feature/topic",
    worktreeName: "task-name",
    name: "task-name",
    split: true,
    additional: false,
  });
  expect(generatedName(named)).toBe("task-name");
  const redirected = resolveBranch(named, "main", first.path, true);
  expect(inputFor(redirected)).toMatchObject({
    path: first.path,
    name: "alpha",
  });
  expect(inputFor(redirected)).not.toHaveProperty("worktreeName");
  expect(inputFor(redirected)).not.toHaveProperty("branch");
  expect(typeWorktreeName(redirected, "fresh").destination).toBeUndefined();
  expect(inputFor(typeWorktreeName(redirected, "fresh"))).toBeUndefined();
  expect(
    changeDestination(named, { branch: "new", label: "new" }, "task-name")
      .worktreeName,
  ).toBe("task-name");
});
