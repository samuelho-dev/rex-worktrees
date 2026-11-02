import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  ClientIdSchema,
  DestinationHostSchema,
  JjRevisionSchema,
  JjWorktreeSchema,
  SessionIdSchema,
  type Draft,
} from "../src/contracts.ts";
import {
  changeDestination,
  changeMachine,
  changeProject,
  changeProjectChoice,
  cloneInputFor,
  generatedName,
  inputFor,
  selectRevision,
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
  vcs: "git" as const,
  path: "/projects/alpha",
  commonDir: "/git/alpha",
  name: "alpha",
};
const alias = {
  vcs: "git" as const,
  path: "/projects/alpha.other",
  commonDir: "/git/alpha",
  name: "alpha",
};
const other = { vcs: "git" as const, path: "/projects/beta", commonDir: "/git/beta", name: "beta" };
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
    vcs: "git",
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
  const draft = changeDestination(
    { ...ready(), worktreeName: "task-alpha" },
    { branch: "feature", label: "feature" },
    "task-alpha",
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
  const named = changeDestination(
    typeWorktreeName(ready(), "task-name"),
    { branch: "feature/topic", label: "feature/topic" },
    "task-name",
  );
  expect(inputFor(named)).toMatchObject({
    branch: "feature/topic",
    worktreeName: "task-name",
    name: "task-name",
    split: true,
    additional: false,
  });
  expect(generatedName(named)).toBe("task-name");
  const redirected = selectWorktree(named, {
    vcs: "git", path: first.path, branch: "main", head: "abc",
    bare: false, locked: false, prunable: false,
  });
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

it("clone draft uses logical source and exact target, without fabricating a target repository", () => {
  const clone: Draft = {
    ...ready(),
    project: undefined,
    clone: {
      url: "https://example.com/alpha.git", sourceHostId: local.hostId,
      vcs: "git", branches: ["main", "feature/pushed"], branch: "main", repo: "/target/alpha"
    },
    destination: { branch: "feature/pushed", label: "feature/pushed" },
    worktreeName: "alpha-feature",
  };
  expect(inputFor(clone)).toBeUndefined();
  expect(cloneInputFor(clone)).toMatchObject({
    repo: "/target/alpha", source: { sourceHostId: local.hostId, url: "https://example.com/alpha.git" },
    branch: "feature/pushed", branchMode: "existing", worktreeName: "alpha-feature",
    sessionId, clientId,
  });
  const newBranch = cloneInputFor({ ...clone, destination: { branch: "new-feature", label: "new-feature" } });
  if (newBranch?.vcs !== "git") throw new Error("Expected Git clone input");
  expect(newBranch.branchMode).toBe("create");
  expect(changeMachine(clone, remote).clone).toBeUndefined();
  expect(changeMachine(clone, remote).sessionId).toBeUndefined();
  expect(changeProjectChoice(clone, { name: "beta" }).clone).toBeUndefined();
  expect(changeProject(clone, other).clone).toBeUndefined();
});

const jj = { vcs: "jj" as const, path: "/projects/alpha", commonDir: "/projects/alpha/.jj/repo", name: "alpha" };
const revision = Schema.decodeUnknownSync(JjRevisionSchema)({
  commitId: "a".repeat(40), changeId: "k".repeat(32), description: "published base"
});
const base = { expression: "main@origin", label: "main@origin", revision };
const mainlineRevision = Schema.decodeUnknownSync(JjRevisionSchema)({
  commitId: "b".repeat(40), changeId: "m".repeat(32), description: "configured trunk"
});
const mainline = { expression: "trunk()", label: "Mainline · bbbbbbbbbbbb · configured trunk", revision: mainlineRevision };
const jjDraft = (): Draft => ({
  ...ready(), project: jj, projectChoice: {
    name: jj.name, source: { machineKey: local.key, hostId: local.hostId, repository: jj }
  }
});

it("JJ existing workspace opens by exact path without a writable base", () => {
  const tree = Schema.decodeUnknownSync(JjWorktreeSchema)({
    vcs: "jj", path: "/projects/alpha.worktrees/task", name: "task",
    head: "a".repeat(40), changeId: "k".repeat(32), present: true, colocated: false
  });
  const opened = selectWorktree(jjDraft(), tree);
  expect(inputFor(opened)).toMatchObject({ vcs: "jj", path: tree.path, repo: tree.path, sessionId });
  expect(opened.projectChoice?.name).toBe(jj.name);
  expect(opened.projectChoice?.source?.repository).toEqual(jj);
  expect(opened.projectChoice?.source?.checkoutPath).toBe(tree.path);
  expect(opened.sourcePath).toBe(tree.path);
  expect(changeMachine(opened, remote).projectChoice?.source).toEqual({
    machineKey: local.key, hostId: local.hostId, repository: jj, checkoutPath: tree.path
  });
  expect(inputFor(opened)).not.toHaveProperty("revision");
  expect(inputFor(opened)).not.toHaveProperty("worktreeName");
  expect(typeWorktreeName(opened, "new-workspace").destination).toBeUndefined();
  expect(inputFor(typeWorktreeName(opened, "new-workspace", mainline))).toMatchObject({
    repo: tree.path, worktreeName: "new-workspace", revision: mainlineRevision.commitId
  });
  expect(inputFor(selectRevision(typeWorktreeName(opened, "new-workspace"), base))).toMatchObject({
    repo: tree.path, worktreeName: "new-workspace", revision: revision.commitId
  });
});

it("unavailable registered JJ workspaces cannot become a path or source", () => {
  const draft = jjDraft();
  const unknown = Schema.decodeUnknownSync(JjWorktreeSchema)({
    vcs: "jj", path: null, name: "legacy",
    head: "a".repeat(40), changeId: "k".repeat(32), present: false, colocated: false
  });
  expect(() => selectWorktree(draft, unknown)).toThrow();
  expect(inputFor(draft)).toBeUndefined();
  expect(draft.sourcePath).toBeUndefined();
  const missing = { ...unknown, path: "/projects/alpha.worktrees/missing" };
  expect(() => selectWorktree(draft, missing)).toThrow();
});

it("JJ new workspace pins configured mainline unless the user selected another revision", () => {
  const named = typeWorktreeName(jjDraft(), "topic");
  expect(inputFor(named)).toBeUndefined();
  const defaulted = typeWorktreeName(jjDraft(), "topic", mainline);
  expect(inputFor(defaulted)).toMatchObject({
    vcs: "jj", worktreeName: "topic", revision: mainlineRevision.commitId, name: "topic", split: true
  });
  expect(inputFor(defaulted)).not.toHaveProperty("branch");
  const pinned = selectRevision(defaulted, base);
  expect(inputFor(typeWorktreeName(pinned, "different", mainline))).toMatchObject({
    vcs: "jj", worktreeName: "different", revision: revision.commitId
  });
  expect(changeMachine(defaulted, remote)).toEqual({ machine: remote, projectChoice: defaulted.projectChoice, mode: "split" });
  expect(changeProject(defaulted, first).destination).toBeUndefined();
  expect(changeProjectChoice(defaulted, { name: "beta" }).destination).toBeUndefined();
  expect(inputFor(changeMachine(defaulted, remote))).toBeUndefined();
  expect(inputFor(changeProjectChoice(defaulted, { name: "beta" }))).toBeUndefined();
});

it("source workspace identity stays local to its host and logical project", () => {
  const source: Draft = { ...jjDraft(), sourcePath: "/projects/alpha.worktrees/source" };
  const pinned = selectRevision(typeWorktreeName(source, "new-workspace"), base);
  expect(inputFor(pinned)?.repo).toBe(source.sourcePath);
  expect(changeProject(pinned, { ...jj, path: "/projects/alpha.worktrees/other" }).sourcePath).toBe(source.sourcePath);
  expect(changeProject(pinned, first).sourcePath).toBeUndefined();
  expect(changeMachine(pinned, remote).sourcePath).toBeUndefined();
  expect(changeProjectChoice(pinned, { name: "beta" }).sourcePath).toBeUndefined();
});

it("JJ clone uses source-resolved full commit ID or the cloned default, not source-relative expressions", () => {
  const draft: Draft = {
    ...jjDraft(), project: undefined,
    clone: {
      vcs: "jj", url: "https://example.com/alpha.git", sourceHostId: local.hostId,
      revisions: [base], repo: "/target/alpha"
    }
  };
  expect(cloneInputFor(draft)).toMatchObject({ vcs: "jj", repo: "/target/alpha", sessionId, clientId });
  expect(cloneInputFor(draft)).not.toHaveProperty("revision");
  const pinned = selectRevision({ ...draft, worktreeName: "topic" }, base);
  expect(cloneInputFor(pinned)).toMatchObject({
    vcs: "jj", worktreeName: "topic", revision: revision.commitId, source: { revisions: [base] }
  });
  const pinnedInput = cloneInputFor(pinned);
  if (pinnedInput?.vcs !== "jj") throw new Error("Expected JJ clone input");
  expect(pinnedInput.revision).not.toBe(base.expression);
  expect(changeMachine(pinned, remote).clone).toBeUndefined();
  expect(changeProjectChoice(pinned, { name: "beta" }).destination).toBeUndefined();
});
