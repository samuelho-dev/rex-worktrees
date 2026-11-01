import { expect, it } from "@effect/vitest"
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import { AppError, JjWorktreeSchema, ServerHostIdSchema, type Environment } from "../src/contracts.ts"
import { cloneRepository, cloneSource, createWorkspace, listRevisions, listWorkspaces, newChange, planWorkspace, project, repository, resolveRevision } from "../src/jj.ts"

function command(program: string, args: string[], cwd?: string) {
  const env: Environment = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value
  const child = Bun.spawnSync([program, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
  if (child.exitCode !== 0) throw new Error(`${program} ${args.join(" ")}: ${new TextDecoder().decode(child.stderr)}`)
  return new TextDecoder().decode(child.stdout).trim()
}
const jj = (repo: string, ...args: string[]) => command("jj", ["-R", repo, ...args])
const git = (repo: string, ...args: string[]) => command("git", ["-C", repo, ...args])

function fixture<A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "rex-jj-")))
      const previous = { JJ_CONFIG: process.env.JJ_CONFIG, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
      process.env.HOME = join(root, "home")
      process.env.XDG_CONFIG_HOME = join(root, "config")
      process.env.JJ_CONFIG = join(root, "config.toml")
      await mkdir(process.env.HOME)
      await writeFile(process.env.JJ_CONFIG, '[user]\nname = "Rex Tests"\nemail = "rex@example.test"\n')
      return { root, previous }
    }),
    ({ root }) => use(root),
    ({ root, previous }) => Effect.promise(async () => {
      for (const key of ["JJ_CONFIG", "HOME", "XDG_CONFIG_HOME"] as const) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
      await rm(root, { recursive: true, force: true })
    })
  ).pipe(Effect.provide(BunServices.layer))
}

it.live("metadata and unsnapshotted inventory distinguish JJ from backing Git and preserve source files", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "project")
  command("jj", ["git", "init", repo])
  const before = yield* repository(repo)
  expect(before.vcs).toBe("jj")
  yield* Effect.promise(() => writeFile(join(repo, "unsnapshotted"), "untouched"))
  const index = yield* Effect.promise(() => readFile(join(repo, ".git", "index")).catch(() => undefined))
  const initial = yield* resolveRevision(repo, "@")
  expect((yield* listWorkspaces(repo))[0]?.head).toBe(initial.commitId)
  expect((yield* listRevisions(repo)).length).toBeGreaterThan(0)
  expect((yield* project(repo)).path).toBe(repo)
  expect((yield* repository(join(repo, "unsnapshotted"))).commonDir).toBe(before.commonDir)
  expect(yield* Effect.promise(() => readFile(join(repo, ".git", "index")).catch(() => undefined))).toEqual(index)
  expect(yield* Effect.promise(() => readFile(join(repo, "unsnapshotted"), "utf8"))).toBe("untouched")
  expect((yield* resolveRevision(repo, "@")).commitId).toBe(initial.commitId)
})))

it.live("configured JJ trunk precedes duplicate parent and preserves unsnapshotted source", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "source")
  command("jj", ["git", "init", "--no-colocate", repo])
  yield* Effect.promise(() => writeFile(join(repo, "published"), "on production"))
  jj(repo, "describe", "-m", "release")
  const mainline = yield* resolveRevision(repo, "@")
  jj(repo, "bookmark", "create", "production", "-r", "@")
  jj(repo, "new", "production")
  yield* Effect.promise(() => writeFile(process.env.JJ_CONFIG!, '[user]\nname = "Rex Tests"\nemail = "rex@example.test"\n[revset-aliases]\n"trunk()" = "production"\n'))
  yield* Effect.promise(() => writeFile(join(repo, "pending"), "not snapshotted"))
  const before = yield* resolveRevision(repo, "@")
  const choices = yield* listRevisions(repo)
  expect(choices[0]?.expression).toBe("trunk()")
  expect(choices[0]?.revision.commitId).toBe(mainline.commitId)
  expect(choices[0]?.label).toMatch(/^Mainline · release · [0-9a-f]{12}$/)
  expect(choices.filter(choice => choice.revision.commitId === mainline.commitId)).toHaveLength(1)
  expect((yield* resolveRevision(repo, "@")).commitId).toBe(before.commitId)
  expect(yield* Effect.promise(() => readFile(join(repo, "pending"), "utf8"))).toBe("not snapshotted")
  const plan = yield* planWorkspace(repo, "from-mainline", choices[0]!.revision.commitId)
  expect(plan.base.commitId).toBe(mainline.commitId)
})))

it.live("root, missing, ambiguous, and conflicted JJ trunk cannot become mainline", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "source")
  command("jj", ["git", "init", "--no-colocate", repo])
  yield* Effect.promise(() => writeFile(join(repo, "shared"), "base"))
  jj(repo, "describe", "-m", "base")
  jj(repo, "bookmark", "create", "production", "-r", "@")
  const base = (yield* resolveRevision(repo, "production")).commitId
  const config = (alias: string) => Effect.promise(() => writeFile(process.env.JJ_CONFIG!, `[user]\nname = "Rex Tests"\nemail = "rex@example.test"\n[revset-aliases]\n"trunk()" = "${alias}"\n`))
  for (const alias of ["root()", "missing-bookmark", "all()"]) {
    yield* config(alias)
    const choices = yield* listRevisions(repo)
    expect(choices.some(choice => choice.expression === "trunk()")).toBe(false)
    expect(choices.some(choice => choice.revision.commitId === base)).toBe(true)
  }
  yield* config("root()")
  jj(repo, "new", "production")
  yield* Effect.promise(() => writeFile(join(repo, "shared"), "first"))
  jj(repo, "describe", "-m", "first")
  const first = (yield* resolveRevision(repo, "@")).commitId
  jj(repo, "new", "production")
  yield* Effect.promise(() => writeFile(join(repo, "shared"), "second"))
  jj(repo, "describe", "-m", "second")
  const second = (yield* resolveRevision(repo, "@")).commitId
  jj(repo, "new", first, second)
  yield* config("@")
  const choices = yield* listRevisions(repo)
  expect(choices.some(choice => choice.expression === "trunk()")).toBe(false)
  expect(choices.some(choice => choice.revision.commitId === base)).toBe(true)
})))

it.live("JJ metadata with unavailable binary reports installation error, not missing repository", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "project")
  command("jj", ["git", "init", repo])
  yield* Effect.promise(() => mkdir(join(root, "empty-path")))
  const error = yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.PATH
      process.env.PATH = join(root, "empty-path")
      return previous
    }),
    () => Effect.flip(repository(repo)),
    previous => Effect.sync(() => {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
    })
  )
  expect(Schema.is(AppError)(error)).toBe(true)
  if (Schema.is(AppError)(error)) expect(error.message).toContain("jj executable not found")
})))

it.live("pinned workspace creation makes a distinct fresh change without requiring a bookmark", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "source")
  command("jj", ["git", "init", "--no-colocate", repo])
  yield* Effect.promise(() => writeFile(join(repo, "base"), "published content"))
  jj(repo, "describe", "-m", "base")
  const base = yield* resolveRevision(repo, "@")
  const plan = yield* planWorkspace(repo, "feature", base.commitId)
  expect(plan.path).toBe(`${repo}.worktrees/feature`)
  const created = yield* createWorkspace(repo, plan.workspaceName, plan.base)
  expect(created.name).toBe("feature")
  expect(created.present).toBe(true)
  expect(created.changeId).not.toBe(base.changeId)
  expect((yield* resolveRevision(created.path, "@-")).commitId).toBe(base.commitId)
  expect(yield* Effect.promise(() => readFile(join(created.path, "base"), "utf8"))).toBe("published content")
  yield* Effect.promise(() => writeFile(join(created.path, "only-in-workspace"), "feature"))
  expect(yield* Effect.promise(() => readdir(repo))).not.toContain("only-in-workspace")
  expect((yield* listWorkspaces(repo)).map(item => item.name)).toEqual(["default", "feature"])
  const second = yield* planWorkspace(created.path, "second", "@-")
  expect(second.repository.path).toBe(created.path)
  expect(second.path).toBe(`${repo}.worktrees/second`)
  expect(second.base.commitId).toBe(base.commitId)
})))

it.live("linked JJ workspace keeps canonical project identity and independent local revision", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "project")
  command("jj", ["git", "init", "--no-colocate", repo])
  const planned = yield* planWorkspace(repo, "linked", "@-")
  const linked = yield* createWorkspace(repo, planned.workspaceName, planned.base)
  expect((yield* repository(linked.path)).path).toBe(linked.path)
  expect((yield* project(linked.path)).path).toBe(repo)
  expect((yield* project(linked.path)).name).toBe("project")
  expect((yield* resolveRevision(linked.path, "@")).commitId).toBe(linked.head)
  expect((yield* resolveRevision(linked.path, "@")).commitId).not.toBe((yield* resolveRevision(repo, "@")).commitId)
})))

it.live("creation snapshots its invoking workspace; unavailable registrations remain discoverable", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "source")
  command("jj", ["git", "init", repo])
  const original = yield* resolveRevision(repo, "@")
  const base = yield* resolveRevision(repo, "@-")
  yield* Effect.promise(() => writeFile(join(repo, "pending"), "source only"))
  expect((yield* resolveRevision(repo, "@")).commitId).toBe(original.commitId)
  const planned = yield* planWorkspace(repo, "task", base.commitId)
  expect((yield* resolveRevision(repo, "@")).commitId).toBe(original.commitId)
  const created = yield* createWorkspace(repo, planned.workspaceName, planned.base)
  expect((yield* resolveRevision(repo, "@")).commitId).not.toBe(original.commitId)
  expect(yield* Effect.promise(() => readdir(created.path))).not.toContain("pending")
  yield* Effect.promise(() => rename(created.path, join(root, "moved")))
  const unavailable = (yield* listWorkspaces(repo)).find(item => item.name === "task")
  expect(unavailable?.present).toBe(false)
  expect(unavailable?.path).toBe(created.path)
  expect(yield* Effect.exit(planWorkspace(repo, "task", base.commitId))).toMatchObject({ _tag: "Failure" })
})))

it.live("unrecorded workspace roots remain explicit unavailable domain records", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "source")
  command("jj", ["git", "init", repo])
  const known = (yield* listWorkspaces(repo))[0]!
  const legacy = Schema.decodeUnknownSync(JjWorktreeSchema)({ ...known, name: "legacy", path: null, present: false, colocated: false })
  expect(legacy.path).toBeNull()
  expect(legacy.present).toBe(false)
  expect((yield* listWorkspaces(repo))[0]?.path).toBe(repo)
})))

it.live("invalid workspace names, colliding destinations, missing and ambiguous revisions never create workspace", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "source")
  command("jj", ["git", "init", "--no-colocate", repo])
  const base = yield* resolveRevision(repo, "@-")
  for (const name of ["../escape", "-option", "a/b", "  ", "bad\nname"]) {
    expect(yield* Effect.exit(planWorkspace(repo, name, base.commitId))).toMatchObject({ _tag: "Failure" })
  }
  expect(yield* Effect.exit(resolveRevision(repo, "all()"))).toMatchObject({ _tag: "Failure" })
  expect(yield* Effect.exit(resolveRevision(repo, "no-such-revision"))).toMatchObject({ _tag: "Failure" })
  const collision = `${repo}.worktrees/collision`
  yield* Effect.promise(() => mkdir(collision, { recursive: true }))
  expect(yield* Effect.exit(planWorkspace(repo, "collision", base.commitId))).toMatchObject({ _tag: "Failure" })
  const first = yield* planWorkspace(repo, "one", base.commitId)
  yield* createWorkspace(repo, first.workspaceName, first.base)
  expect(yield* Effect.exit(planWorkspace(repo, "one", base.commitId))).toMatchObject({ _tag: "Failure" })
  expect((yield* listWorkspaces(repo)).map(item => item.name)).toEqual(["default", "one"])
  expect(yield* Effect.promise(() => readdir(repo))).not.toContain("escape")
})))

it.live("a single merge commit is a valid base while a multi-result revset is not", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "merged")
  command("git", ["init", "-b", "main", repo])
  git(repo, "config", "user.name", "Rex Tests")
  git(repo, "config", "user.email", "rex@example.test")
  yield* Effect.promise(() => writeFile(join(repo, "initial"), "base"))
  git(repo, "add", "initial")
  git(repo, "commit", "-m", "initial")
  git(repo, "checkout", "-b", "feature")
  yield* Effect.promise(() => writeFile(join(repo, "feature"), "feature"))
  git(repo, "add", "feature")
  git(repo, "commit", "-m", "feature")
  git(repo, "checkout", "main")
  yield* Effect.promise(() => writeFile(join(repo, "main"), "main"))
  git(repo, "add", "main")
  git(repo, "commit", "-m", "main")
  git(repo, "merge", "--no-ff", "feature", "-m", "merge")
  const mergeId = git(repo, "rev-parse", "HEAD")
  command("jj", ["git", "init", repo])
  const merge = yield* resolveRevision(repo, mergeId)
  expect(merge.commitId).toBe(mergeId)
  expect((yield* planWorkspace(repo, "from-merge", mergeId)).base.commitId).toBe(mergeId)
  expect((yield* listRevisions(repo)).some(choice => choice.revision.commitId === mergeId)).toBe(true)
  expect(yield* Effect.exit(resolveRevision(repo, "all()"))).toMatchObject({ _tag: "Failure" })
})))

it.live("external backing Git metadata cannot become a JJ workspace root", () => fixture(root => Effect.gen(function*() {
  const gitRoot = join(root, "external.git")
  command("git", ["init", "--bare", gitRoot])
  const repo = join(root, "linked")
  command("jj", ["git", "init", "--git-repo", gitRoot, repo])
  const base = yield* resolveRevision(repo, "@-")
  expect(yield* Effect.exit(planWorkspace(repo, "inside-git", base.commitId, gitRoot))).toMatchObject({ _tag: "Failure" })
  expect((yield* listWorkspaces(repo)).map(item => item.name)).toEqual(["default"])
})))

it.live("a hash-named Git tag cannot shadow the reviewed JJ base at workspace add", () => fixture(root => Effect.gen(function*() {
  const repo = join(root, "tagged")
  command("git", ["init", "-b", "main", repo])
  git(repo, "config", "user.name", "Rex Tests")
  git(repo, "config", "user.email", "rex@example.test")
  yield* Effect.promise(() => writeFile(join(repo, "one"), "one"))
  git(repo, "add", "one")
  git(repo, "commit", "-m", "one")
  const reviewedId = git(repo, "rev-parse", "HEAD")
  yield* Effect.promise(() => writeFile(join(repo, "two"), "two"))
  git(repo, "add", "two")
  git(repo, "commit", "-m", "two")
  const differentId = git(repo, "rev-parse", "HEAD")
  command("jj", ["git", "init", repo])
  const plan = yield* planWorkspace(repo, "pinned", reviewedId)
  git(repo, "tag", reviewedId, differentId)
  const created = yield* createWorkspace(repo, plan.workspaceName, plan.base)
  expect((yield* resolveRevision(created.path, "@-")).commitId).toBe(reviewedId)
})))

it.live("native clone transfers pushed commits only and a selected unpublished base leaves cloned checkout", () => fixture(root => Effect.gen(function*() {
  const bare = join(root, "origin.git")
  command("git", ["init", "--bare", bare])
  const seed = join(root, "seed")
  command("git", ["init", "-b", "main", seed])
  git(seed, "config", "user.name", "Rex Tests")
  git(seed, "config", "user.email", "rex@example.test")
  yield* Effect.promise(() => writeFile(join(seed, "published"), "published"))
  git(seed, "add", "published")
  git(seed, "commit", "-m", "published")
  git(seed, "remote", "add", "origin", bare)
  git(seed, "push", "-u", "origin", "main")
  command("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"])
  const source = join(root, "source")
  yield* cloneRepository(bare, source)
  const hostId = Schema.decodeUnknownSync(ServerHostIdSchema)("fixture-host")
  expect((yield* cloneSource(source, hostId)).url).toBe(bare)
  git(source, "config", "remote.origin.pushurl", "ssh://git@example.org/owner/project.git")
  expect(jj(source, "--ignore-working-copy", "--at-op=@", "git", "remote", "list")).toContain("(push:")
  expect((yield* cloneSource(source, hostId)).url).toBe(bare)
  yield* Effect.promise(() => writeFile(join(source, "unpublished"), "local only"))
  jj(source, "describe", "-m", "not pushed")
  const local = yield* resolveRevision(source, "@")
  const target = join(root, "target")
  yield* cloneRepository(bare, target)
  expect(yield* Effect.promise(() => readdir(target))).not.toContain("unpublished")
  expect(yield* Effect.exit(newChange(target, local))).toMatchObject({ _tag: "Failure" })
  expect((yield* repository(target)).vcs).toBe("jj")
  const published = yield* resolveRevision(target, "@-")
  const task = yield* newChange(target, published)
  expect((yield* resolveRevision(target, "@-")).commitId).toBe(published.commitId)
  expect(task.changeId).not.toBe(published.changeId)
})))
