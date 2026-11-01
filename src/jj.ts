import { Effect, FileSystem, Path, PlatformError, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { planCheckoutPath } from "./checkout.ts"
import {
  AppError, CommandError, JjChangeIdSchema, JjCommitIdSchema, JjWorkspaceNameSchema,
  type Environment, type JjRepository, type JjRevision,
  type JjCloneSource, type JjRevisionChoice, type JjWorktree, type JjWorkspaceName, type ServerHostId
} from "./contracts.ts"
import { safeOrigin } from "./git.ts"
import { run } from "./process.ts"

const fail = (message: string) => Effect.fail(new AppError({ message }))
const missing = (error: unknown) => PlatformError.isPlatformError(error) && error.reason._tag === "NotFound"
const isolatedEnv = (): Environment => {
  const env: Environment = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value
  env.LC_ALL = "C"
  return env
}
const jj = (repo: string, ...args: string[]) => run("jj", ["-R", repo, "--no-pager", "--color=never", ...args], undefined, isolatedEnv())
const inventory = (repo: string, ...args: string[]) => jj(repo, "--ignore-working-copy", "--at-op=@", ...args)
const version = Effect.fnUntraced(function*() {
  for (const [program, minimum] of [["jj", [0, 46]], ["git", [2, 42]]] as const) {
    const output = yield* run(program, ["--version"], undefined, isolatedEnv()).pipe(
      Effect.catchIf(
        error => missing(error),
        () => fail(`${program} executable not found on this Rex host; install ${program} >= ${minimum.join(".")} and ensure it is on the popup/task PATH`)
      )
    )
    const match = /\b(\d+)\.(\d+)(?:\.\d+)?\b/.exec(output)
    if (!match || Number(match[1]) < minimum[0] || (Number(match[1]) === minimum[0] && Number(match[2]) < minimum[1])) {
      return yield* fail(`Requires ${program} >= ${minimum.join(".")}`)
    }
  }
})
const workspaceTemplate = 'json({"name" => name, "path" => root, "commitId" => self.target().commit_id(), "changeId" => self.target().change_id()}) ++ "\\n"'
const revisionTemplate = 'json({"commitId" => commit_id, "changeId" => change_id, "description" => description, "conflict" => self.conflict()}) ++ "\\n"'
const workspaceRow = Schema.Struct({ name: JjWorkspaceNameSchema, path: Schema.NullOr(Schema.String), commitId: JjCommitIdSchema, changeId: JjChangeIdSchema })
const revisionRow = Schema.Struct({ commitId: JjCommitIdSchema, changeId: JjChangeIdSchema, description: Schema.String, conflict: Schema.Boolean })
const bookmarkRow = Schema.Struct({ name: Schema.String, remote: Schema.NullOr(Schema.String), present: Schema.Boolean, conflict: Schema.Boolean, target: Schema.String })
const bookmarkTemplate = 'json({"name" => name, "remote" => remote, "present" => present, "conflict" => conflict, "target" => try(self.normal_target().commit_id(), "")}) ++ "\\n"'
const rows = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, raw: string) => Effect.forEach(raw.split("\n").filter(Boolean), line => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(line))
const validName = Effect.fnUntraced(function*(value: string) {
  if (!value.trim() || value !== value.trim() || value.startsWith("-") || /[\\/\p{Cc}]/u.test(value) || value === "." || value === "..") return yield* fail("Invalid JJ workspace name")
  return yield* Schema.decodeUnknownEffect(JjWorkspaceNameSchema)(value)
})
const validPin = Effect.fnUntraced(function*(id: string) {
  if (!/^[0-9a-f]{40,64}$/.test(id)) return yield* fail("Invalid full JJ base commit ID")
  return yield* Schema.decodeUnknownEffect(JjCommitIdSchema)(id)
})
const marker = Effect.fnUntraced(function*(input: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  let directory = yield* fs.realPath(input)
  const info = yield* fs.stat(directory)
  if (info.type !== "Directory") directory = path.dirname(directory)
  for (;;) {
    const dot = path.join(directory, ".jj")
    const exists = yield* fs.stat(dot).pipe(Effect.catchIf(missing, () => Effect.succeed(undefined)))
    if (exists) {
      if (exists.type !== "Directory") return yield* fail("Invalid JJ workspace metadata")
      return { directory, dot }
    }
    const parent = path.dirname(directory)
    if (parent === directory) return yield* fail("Not a JJ repository")
    directory = parent
  }
})
const metadata = Effect.fnUntraced(function*(dot: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const pointer = path.join(dot, "repo")
  const entry = yield* fs.stat(pointer).pipe(Effect.catchIf(missing, () => fail("JJ workspace has no repository metadata")))
  if (entry.type === "Directory") return yield* fs.realPath(pointer)
  if (entry.type !== "File") return yield* fail("Invalid JJ repository pointer")
  const text = (yield* fs.readFileString(pointer)).trim()
  if (!text || text.includes("\0")) return yield* fail("Invalid JJ repository pointer")
  const target = yield* fs.realPath(path.resolve(dot, text))
  if ((yield* fs.stat(target)).type !== "Directory") return yield* fail("Invalid JJ repository pointer")
  return target
})
export const repository = Effect.fnUntraced(function*(input: string) {
  yield* version()
  const path = yield* Path.Path
  const { directory, dot } = yield* marker(input)
  return { vcs: "jj", path: directory, commonDir: yield* metadata(dot), name: path.basename(directory) } satisfies JjRepository
})
export const listWorkspaces = Effect.fnUntraced(function*(repo: string) {
  const current = yield* repository(repo)
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parsed = yield* rows(workspaceRow, yield* inventory(current.path, "workspace", "list", "-T", workspaceTemplate))
  return yield* Effect.forEach(parsed, item => Effect.gen(function*() {
    if (!item.path) return { vcs: "jj", path: null, name: item.name, head: item.commitId, changeId: item.changeId, present: false, colocated: false } satisfies JjWorktree
    const location = path.resolve(item.path)
    const real = yield* fs.realPath(location).pipe(Effect.catchIf(missing, () => Effect.succeed(undefined)))
    let present = false
    if (real) {
      const dot = yield* fs.stat(path.join(real, ".jj")).pipe(Effect.catchIf(missing, () => Effect.succeed(undefined)))
      if (dot?.type === "Directory") {
        const linked = yield* metadata(path.join(real, ".jj"))
        present = linked === current.commonDir
      }
    }
    const colocated = present && !!(yield* fs.stat(path.join(real!, ".git")).pipe(Effect.catchIf(missing, () => Effect.succeed(undefined))))
    return { vcs: "jj", path: real ?? location, name: item.name, head: item.commitId, changeId: item.changeId, present, colocated } satisfies JjWorktree
  }))
})
export const project = Effect.fnUntraced(function*(input: string) {
  const current = yield* repository(input)
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const primaryPath = path.dirname(path.dirname(current.commonDir))
  const primary = (yield* listWorkspaces(current.path)).find(item => item.path === primaryPath)
  if (!primary?.present) return current
  return { ...current, path: yield* fs.realPath(primaryPath), name: path.basename(primaryPath) } satisfies JjRepository
})
export const resolveRevision = Effect.fnUntraced(function*(repo: string, expression: string) {
  if (!expression.trim() || expression.startsWith("-") || /[\p{Cc}]/u.test(expression)) return yield* fail("Invalid JJ base revision")
  const current = yield* repository(repo)
  const revset = /^[0-9a-f]{40,64}$/.test(expression) ? `commit_id("${expression}")` : expression
  const parsed = yield* rows(revisionRow, yield* inventory(current.path, "log", "-r", revset, "--no-graph", "--limit", "2", "-T", revisionTemplate))
  if (parsed.length !== 1 || parsed[0]!.conflict) return yield* fail("JJ base must resolve to one non-conflicted revision")
  const { commitId, changeId, description } = parsed[0]!
  return { commitId, changeId, description } satisfies JjRevision
})
export const listRevisions = Effect.fnUntraced(function*(repo: string) {
  const current = yield* repository(repo)
  const bookmarks = (yield* rows(bookmarkRow, yield* inventory(current.path, "bookmark", "list", "-T", bookmarkTemplate)))
    .filter(item => item.present && !item.conflict && /^[0-9a-f]{40,64}$/.test(item.target))
  const choices: JjRevisionChoice[] = []
  const mainline = yield* inventory(current.path, "log", "-r", "trunk()", "--no-graph", "--limit", "2", "-T", revisionTemplate).pipe(
    Effect.catchIf(
      error => Schema.is(CommandError)(error) && error.program === "jj" && /^Error: (?:Failed to (?:parse|resolve) revset|Invalid revset|Revision |Revset |Cannot resolve |No such revision)/i.test(error.stderr),
      () => Effect.succeed("")
    )
  )
  const mainlineRows = yield* rows(revisionRow, mainline)
  if (mainlineRows.length === 1 && !mainlineRows[0]!.conflict && !/^0+$/.test(mainlineRows[0]!.commitId)) {
    const item = mainlineRows[0]!
    choices.push({
      expression: "trunk()",
      label: `Mainline · ${item.description.trim() || item.changeId.slice(0, 12)} · ${item.commitId.slice(0, 12)}`,
      revision: { commitId: item.commitId, changeId: item.changeId, description: item.description }
    })
  }
  const candidates = ["@-", "bookmarks()", "remote_bookmarks()"]
  for (const expression of candidates) {
    const raw = yield* inventory(current.path, "log", "-r", expression, "--no-graph", "--limit", "40", "-T", revisionTemplate)
    for (const item of yield* rows(revisionRow, raw)) {
      if (item.conflict || choices.some(choice => choice.revision.commitId === item.commitId)) continue
      const revision = { commitId: item.commitId, changeId: item.changeId, description: item.description }
      const ref = bookmarks.find(bookmark => bookmark.target === item.commitId && (expression === "remote_bookmarks()" ? bookmark.remote !== null : bookmark.remote === null))
      const label = expression === "@-" ? "Parent" : ref ? `${ref.name}${ref.remote ? `@${ref.remote}` : ""}` : expression === "bookmarks()" ? "Bookmark" : "Remote bookmark"
      choices.push({ expression: item.commitId, label: `${label} · ${item.description.trim() || item.changeId.slice(0, 12)} · ${item.commitId.slice(0, 12)}`, revision })
    }
  }
  return choices
})
const gitRoot = Effect.fnUntraced(function*(repo: string) {
  const fs = yield* FileSystem.FileSystem
  const raw = (yield* inventory(repo, "git", "root")).trim()
  if (!raw) return yield* fail("JJ backing Git directory is unavailable")
  return yield* fs.realPath(raw)
})
export const cloneSource = Effect.fnUntraced(function*(repo: string, sourceHostId: ServerHostId) {
  const current = yield* repository(repo)
  const raw = yield* run("git", ["--git-dir", yield* gitRoot(current.path), "config", "--get", "remote.origin.url"], undefined, isolatedEnv())
    .pipe(Effect.catch(() => fail("JJ repository has no usable origin URL")))
  const url = yield* Effect.try({ try: () => safeOrigin(raw.replace(/\n$/, ""), true, current.path), catch: () => new AppError({ message: "JJ origin URL is unsafe or local to another Rex host" }) })
  const revisions = yield* listRevisions(current.path)
  const remote = (yield* rows(bookmarkRow, yield* inventory(current.path, "bookmark", "list", "-T", bookmarkTemplate)))
    .filter(item => item.present && !item.conflict && item.remote === "origin")
  const revision = remote.length === 1 ? revisions.find(choice => choice.revision.commitId === remote[0]!.target)?.revision : undefined
  return { vcs: "jj", url, sourceHostId, revisions, ...(revision ? { revision } : {}) } satisfies JjCloneSource
})
export const planWorkspace = Effect.fnUntraced(function*(repo: string, name: string, revision: string, worktreeRoot?: string) {
  const workspaceName = yield* validName(name)
  const source = yield* repository(repo)
  const primary = yield* project(source.path)
  const workspaces = yield* listWorkspaces(source.path)
  if (workspaces.some(item => item.name === workspaceName)) return yield* fail(`JJ workspace ${name} already registered; inspect it before retrying`)
  const base = yield* resolveRevision(source.path, revision)
  const gitDirectory = yield* gitRoot(primary.path)
  const path = yield* planCheckoutPath(primary.path, [primary.commonDir, gitDirectory], workspaces.flatMap(item => item.path === null ? [] : [item.path]), name, worktreeRoot)
  return { repository: source, path, workspaceName, base }
})
export const createWorkspace = Effect.fnUntraced(function*(repo: string, name: JjWorkspaceName, base: JjRevision, worktreeRoot?: string) {
  const pin = yield* validPin(base.commitId)
  const planned = yield* planWorkspace(repo, name, pin, worktreeRoot)
  if (planned.base.changeId !== base.changeId || planned.base.commitId !== pin) return yield* fail("JJ base changed since review; inspect before retrying")
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(planned.path), { recursive: true })
  if ((yield* fs.realPath(path.dirname(planned.path))) !== path.dirname(planned.path)) return yield* fail("Symlinked JJ workspace parent")
  yield* jj(planned.repository.path, "workspace", "add", "--name", name, "-r", `commit_id("${pin}")`, planned.path)
  const created = (yield* listWorkspaces(planned.repository.path)).find(item => item.name === name && item.path === planned.path)
  if (!created?.present) return yield* fail(`JJ did not list created workspace at ${planned.path}; inspect before retrying`)
  return created
})
export const newChange = Effect.fnUntraced(function*(repo: string, base: JjRevision) {
  const pin = yield* validPin(base.commitId)
  const current = yield* repository(repo)
  const resolved = yield* resolveRevision(current.path, pin)
  if (resolved.changeId !== base.changeId) return yield* fail("Selected JJ base is unavailable in destination clone; clone retained")
  const before = (yield* listWorkspaces(current.path)).find(item => item.path === current.path)
  if (!before?.present) return yield* fail("Cloned JJ default workspace is unavailable")
  yield* jj(current.path, "new", "-r", `commit_id("${pin}")`)
  const after = (yield* listWorkspaces(current.path)).find(item => item.name === before.name)
  if (!after?.present) return yield* fail("JJ did not list cloned default workspace after new change")
  return after
})
export const cloneRepository = Effect.fnUntraced(function*(url: string, destination: string) {
  yield* version()
  const safe = yield* Effect.try({ try: () => safeOrigin(url, true), catch: () => new AppError({ message: "Unsafe JJ clone URL" }) })
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make("jj", ["git", "clone", safe, destination], {
    env: isolatedEnv(), stdin: "inherit", stdout: "inherit", stderr: "inherit"
  })).pipe(Effect.mapError(() => new AppError({ message: "Unable to launch JJ clone; destination may need inspection" })))
  const code = yield* child.exitCode
  if (code !== 0) return yield* fail(`JJ clone failed (exit ${code}); destination retained at ${destination}`)
}, Effect.scoped)
