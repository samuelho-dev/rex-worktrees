import { resolve as resolvePath } from "node:path"
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { run } from "./process.ts"
import { AppError, CommandError, type GitCloneSource, type CreateWorktreeOptions, type Environment, type ServerHostId, type GitWorktree } from "./contracts.ts"
import { planCheckoutPath } from "./checkout.ts"

const fail = (message: string) => Effect.fail(new AppError({ message }))
export const missing = (error: unknown) => PlatformError.isPlatformError(error) && error.reason._tag === "NotFound"
export const notRepository = (error: unknown) =>
  Schema.is(CommandError)(error) && error.program === "git" && error.args.includes("rev-parse") &&
  (error.stderr.startsWith("fatal: not a git repository") || error.stderr.startsWith("fatal: this operation must be run in a work tree"))

const git = (cwd: string, ...args: string[]) => {
  // Git repository/index environment overrides -C; strip them for checkout isolation.
  const env: Environment = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value
  }
  env.LC_ALL = "C"
  return run("git", ["-C", cwd, ...args], undefined, env)
}
export const gitContext = Effect.fnUntraced(function*(directory: string) {
  return yield* git(directory, "rev-parse", "--absolute-git-dir").pipe(
    Effect.map(output => output.trim()),
    Effect.catchIf(notRepository, () => Effect.succeed(undefined))
  )
})
// A remote locator is never an identity or an error message: rejected values can contain secrets.
export const safeOrigin = (raw: string, sameHost: boolean, base?: string): string => {
  if (!raw || raw.startsWith("-") || /[\p{ASCII}&&\p{Cc}]/v.test(raw) || /^[a-z][a-z0-9+.-]*::/i.test(raw)) throw new Error("Unsafe origin URL")
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("file://")) {
    if (!sameHost) throw new Error("Local source origins require the same Rex host")
    if (raw.startsWith("file://")) {
      const url = new URL(raw)
      if (url.host || url.search || url.hash || !url.pathname.startsWith("/")) throw new Error("Unsafe origin URL")
      const decoded = decodeURIComponent(url.pathname)
      if (/[\p{ASCII}&&\p{Cc}]/v.test(decoded)) throw new Error("Unsafe origin URL")
      return decoded
    }
    if (!base && !raw.startsWith("/")) throw new Error("Unsafe origin URL")
    return raw.startsWith("/") ? raw : resolvePath(base!, raw)
  }
  if (/\s/.test(raw)) throw new Error("Unsafe origin URL")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const url = new URL(raw)
    if (!["https:", "ssh:", "git:"].includes(url.protocol) || !url.hostname || !url.pathname || url.search || url.hash ||
      (url.protocol === "ssh:" ? (!!url.password || (!!url.username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(url.username))) : !!url.username || !!url.password)) throw new Error("Unsafe origin URL")
    return raw
  }
  if (/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[\w.-]+:[a-zA-Z0-9_./~+%-][a-zA-Z0-9_./~+%:-]*$/.test(raw)) return raw
  throw new Error("Unsafe origin URL")
}

export const origin = Effect.fnUntraced(function*(repoPath: string) {
  const raw = yield* git(repoPath, "config", "--get", "remote.origin.url").pipe(Effect.catch(() => fail("Repository has no usable origin URL")))
  return yield* Effect.try({ try: () => safeOrigin(raw.replace(/\n$/, ""), true, repoPath),
    catch: () => new AppError({ message: "Repository origin URL is unsafe or local to another Rex host" }) })
})

export const cloneSource = Effect.fnUntraced(function*(repoPath: string, sourceHostId: ServerHostId) {
  const repo = yield* repository(repoPath)
  const url = yield* origin(repo.path)
  const refs = yield* git(repo.path, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin")
  const branches = [...new Set(refs.split("\n").flatMap(ref =>
    ref.startsWith("refs/heads/") ? [ref.slice("refs/heads/".length)] :
    ref.startsWith("refs/remotes/origin/") && ref !== "refs/remotes/origin/HEAD" ? [ref.slice("refs/remotes/origin/".length)] : []
  ))]
  const remoteHead = yield* git(repo.path, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD").pipe(Effect.catch(() => Effect.succeed("")))
  const current = yield* git(repo.path, "branch", "--show-current")
  const branch = (remoteHead.trim().replace(/^refs\/remotes\/origin\//, "") || current.trim()) || undefined
  const source: GitCloneSource = { vcs: "git", url, sourceHostId, branches, ...(branch ? { branch } : {}) }
  return source
})

export const remoteBranches = Effect.fnUntraced(function*(repoPath: string) {
  const refs = yield* git(repoPath, "for-each-ref", "--format=%(refname)", "refs/remotes/origin")
  return refs.split("\n").filter(ref => ref.startsWith("refs/remotes/origin/") && ref !== "refs/remotes/origin/HEAD").map(ref => ref.slice("refs/remotes/origin/".length))
})
export const remoteBranchHead = Effect.fnUntraced(function*(repoPath: string, branch: string) {
  return (yield* git(repoPath, "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`)).trim()
})
export const originDefaultHead = Effect.fnUntraced(function*(repoPath: string) {
  const ref = yield* git(repoPath, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD").pipe(
    Effect.catch(() => fail("Cannot determine the existing repository's cached origin default branch"))
  )
  return (yield* git(repoPath, "rev-parse", "--verify", `${ref.trim()}^{commit}`)).trim()
})

export const cloneRepository = Effect.fnUntraced(function*(url: string, destination: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const env: Environment = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && value !== undefined) env[key] = value
  env.GIT_TERMINAL_PROMPT = "1"
  const child = yield* spawner.spawn(ChildProcess.make("git", ["clone", "--origin", "origin", "--", url, destination], {
    env, stdin: "inherit", stdout: "inherit", stderr: "inherit"
  }))
  const code = yield* child.exitCode
  if (code !== 0) return yield* fail(`Git clone failed (exit ${code}); destination retained at ${destination}`)
}, Effect.scoped)
export const validCloneBranch = Effect.fnUntraced(function*(branch: string, worktreeName?: string) {
  if (!branch || branch.startsWith("-") || branch.split("/").some(part => !part || part === "." || part === "..") || /[\p{ASCII}&&\p{Cc}]/v.test(branch)) return yield* fail("Invalid clone branch")
  yield* run("git", ["check-ref-format", "--branch", branch]).pipe(Effect.catch(() => fail("Invalid clone branch")))
  if (worktreeName !== undefined && (!worktreeName.trim() || worktreeName.startsWith("-") || worktreeName.split(/[\\/]/).some(part => !part || part === "." || part === "..") || /[\p{ASCII}&&\p{Cc}]/v.test(worktreeName))) return yield* fail("Invalid worktree name")
})

export const listWorktrees = Effect.fnUntraced(function*(repoPath: string) {
    const output = yield* git(repoPath, "worktree", "list", "--porcelain", "-z")
    const records: GitWorktree[] = []
    let record: GitWorktree | undefined
    for (const line of output.split("\0")) {
      if (line === "") {
        if (record) records.push(record)
        record = undefined
      } else if (line.startsWith("worktree ")) {
        record = { vcs: "git", path: line.slice(9), branch: null, head: "", bare: false, locked: false, prunable: false }
      } else if (record) {
        if (line.startsWith("HEAD ")) record.head = line.slice(5)
        else if (line.startsWith("branch refs/heads/")) record.branch = line.slice(18)
        else if (line === "bare") record.bare = true
        else if (line.startsWith("locked")) record.locked = true
        else if (line.startsWith("prunable")) record.prunable = true
      }
    }
    const fs = yield* FileSystem.FileSystem
    return yield* Effect.forEach(records, (record) => Effect.catchIf(
      fs.realPath(record.path).pipe(Effect.map((real) => ({ ...record, path: real }))),
      (error) => missing(error),
      () => Effect.succeed(record)
    ))
})

export const repository = Effect.fnUntraced(function*(input: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const canonical = yield* fs.realPath(input)
    const top = (yield* git(canonical, "rev-parse", "--show-toplevel")).replace(/\n$/, "")
    const common = (yield* git(canonical, "rev-parse", "--path-format=absolute", "--git-common-dir")).replace(/\n$/, "")
    return { vcs: "git" as const, path: yield* fs.realPath(top), commonDir: yield* fs.realPath(path.resolve(canonical, common)), name: path.basename(top) }
})

export const project = Effect.fnUntraced(function*(input: string) {
    const checkout = yield* repository(input)
    const path = yield* Path.Path
    const [primary] = yield* listWorktrees(checkout.path)
    if (!primary) return checkout
    if (primary.path === checkout.path) return checkout
    const main = primary.bare ? undefined : yield* repository(primary.path).pipe(
      Effect.catchIf(error => missing(error) || notRepository(error), () => Effect.succeed(undefined))
    )
    return main?.commonDir === checkout.commonDir
      ? main
      : { ...checkout, name: path.basename(primary.path) }
})


export const listBranches = Effect.fnUntraced(function*(repoPath: string) {
    const refs = yield* git(repoPath, "for-each-ref", "--format=%(refname)%00", "refs/heads")
    return refs.split("\0\n").filter(Boolean).map((ref) => ref.replace(/^refs\/heads\//, ""))
})

export const repositoryHead = Effect.fnUntraced(function*(repoPath: string) {
    const head = (yield* git(repoPath, "rev-parse", "--verify", "HEAD")).trim()
    const branch = (yield* git(repoPath, "branch", "--show-current")).trim()
    return { branch: branch || null, head }
})


export const planWorktree = Effect.fnUntraced(function*(repoPath: string, branch: string, worktreeRoot?: string, worktreeName?: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (!branch || branch.startsWith("-") || branch.includes("\0") || branch.split("/").some((part) => part === "." || part === ".." || part === "")) {
      return yield* fail(`Invalid branch name: ${JSON.stringify(branch)}`)
    }
    yield* git(repoPath, "check-ref-format", "--branch", branch)
    if (worktreeName !== undefined && (!worktreeName.trim() || path.isAbsolute(worktreeName) || /[\p{ASCII}&&\p{Cc}]/v.test(worktreeName) ||
      worktreeName.split(/[\\/]/).some((part) => !part || part === "." || part === ".."))) {
      return yield* fail(`Invalid worktree name: ${JSON.stringify(worktreeName)}`)
    }
    const repo = yield* repository(repoPath)
    const worktrees = yield* listWorktrees(repo.path)
    const checked = worktrees.find((worktree) => worktree.branch === branch)
    if (checked) {
      const gitFile = yield* Effect.catchIf(fs.stat(path.join(checked.path, ".git")), (error) => missing(error), () => Effect.succeed(undefined))
      if (checked.prunable || !gitFile) {
        return yield* fail(`Branch ${branch} is assigned to an unavailable checkout: ${checked.path}`)
      }
      return { repository: repo, path: checked.path, branch, existing: true }
    }
    const main = worktrees.find((worktree) => !worktree.bare)
    if (!main) return yield* fail("No main checkout exists")
    const destination = yield* planCheckoutPath(main.path, [repo.commonDir], worktrees.map((worktree) => worktree.path), worktreeName ?? branch, worktreeRoot)
    return { repository: repo, path: destination, branch, existing: false }
})

export const createWorktree = Effect.fnUntraced(function*(repoPath: string, branch: string, options: CreateWorktreeOptions = {}) {
    const { startPoint: pinned, attachOnly, worktreeRoot, worktreeName } = options
    if (pinned !== undefined && !/^[0-9a-f]{40,64}$/.test(pinned)) return yield* fail("Invalid pinned base commit")
    if (pinned !== undefined && (yield* listBranches(repoPath)).includes(branch)) return yield* fail(`Branch ${branch} appeared after review; inspect before retrying`)
    if (attachOnly && !(yield* listBranches(repoPath)).includes(branch)) return yield* fail(`Branch ${branch} disappeared after review; inspect before retrying`)
    const plan = yield* planWorktree(repoPath, branch, worktreeRoot, worktreeName)
    if (plan.existing) {
      if (pinned !== undefined || attachOnly) return yield* fail(`Branch ${branch} changed checkout after review; inspect before retrying`)
      const worktrees = yield* listWorktrees(plan.repository.path)
      const existing = worktrees.find((worktree) => worktree.path === plan.path)
      if (!existing) return yield* fail(`Worktree ${plan.path} disappeared after review; inspect before retrying`)
      return existing
    }
    const branches = yield* listBranches(plan.repository.path)
    const branchExists = branches.includes(branch)
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (pinned !== undefined && branchExists) return yield* fail(`Branch ${branch} appeared after review; inspect before retrying`)
    if (attachOnly && !branchExists) return yield* fail(`Branch ${branch} disappeared after review; inspect before retrying`)
    // Re-plan after locating the branch; Git itself rejects racing worktree claims.
    const current = yield* planWorktree(repoPath, branch, worktreeRoot, worktreeName)
    if (current.existing) {
      if (pinned !== undefined || attachOnly) return yield* fail(`Branch ${branch} changed checkout after review; inspect before retrying`)
      const existing = (yield* listWorktrees(plan.repository.path)).find((worktree) => worktree.path === current.path)
      if (!existing) return yield* fail(`Worktree ${current.path} disappeared after review; inspect before retrying`)
      return existing
    }
    yield* fs.makeDirectory(path.dirname(current.path), { recursive: true })
    if ((yield* fs.realPath(path.dirname(current.path))) !== path.dirname(current.path)) {
      return yield* fail(`Symlinked worktree parent: ${path.dirname(current.path)}`)
    }
    yield* git(plan.repository.path, "worktree", "add", ...(pinned !== undefined || (!branchExists && !attachOnly) ? ["-b", branch] : []), "--", current.path, ...(pinned !== undefined ? [pinned] : branchExists || attachOnly ? [branch] : []))
    const created = (yield* listWorktrees(plan.repository.path)).find((worktree) => worktree.path === current.path)
    if (!created) return yield* fail(`Git did not list created worktree ${current.path}`)
    return created
})
