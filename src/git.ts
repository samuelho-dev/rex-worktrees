import { Effect, FileSystem, Option, Path, PlatformError, Schema } from "effect"
import { run } from "./process.ts"
import { AppError, CommandError, type CreateWorktreeOptions, type Environment, type Repository, type Worktree } from "./contracts.ts"

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

export const listWorktrees = Effect.fnUntraced(function*(repoPath: string) {
    const output = yield* git(repoPath, "worktree", "list", "--porcelain", "-z")
    const records: Worktree[] = []
    let record: Worktree | undefined
    for (const line of output.split("\0")) {
      if (line === "") {
        if (record) records.push(record)
        record = undefined
      } else if (line.startsWith("worktree ")) {
        record = { path: line.slice(9), branch: null, head: "", bare: false, locked: false, prunable: false }
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
    return { path: yield* fs.realPath(top), commonDir: yield* fs.realPath(path.resolve(canonical, common)), name: path.basename(top) }
})

export const project = Effect.fnUntraced(function*(input: string) {
    const checkout = yield* repository(input)
    const path = yield* Path.Path
    const [primary] = yield* listWorktrees(checkout.path)
    if (!primary) return checkout
    if (primary.path === checkout.path) return checkout
    const main = primary.bare ? undefined : yield* Effect.catchIf(
      Effect.catchIf(repository(primary.path), (error) => missing(error), () => Effect.succeed(undefined)),
      (error) => notRepository(error),
      () => Effect.succeed(undefined)
    )
    return main?.commonDir === checkout.commonDir
      ? main
      : { ...checkout, name: path.basename(primary.path) }
})

export const discoverProjects = Effect.fnUntraced(function*(roots: readonly string[], explicitProjects: readonly string[], contextPath?: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const candidates = [...(contextPath ? [contextPath] : []), ...explicitProjects]
    for (const root of roots) {
      if (!(yield* fs.exists(root))) continue
      candidates.push(root)
      // ponytail: Two levels of candidates, never a recursive walk through home or build trees.
      for (const name of yield* fs.readDirectory(root)) {
        const first = path.join(root, name)
        if (!(yield* fs.exists(first))) continue
        const info = yield* fs.stat(first)
        if (info.type !== "Directory") continue
        candidates.push(first)
        for (const child of yield* fs.readDirectory(first)) {
          const second = path.join(first, child)
          if ((yield* fs.exists(second)) && (yield* fs.stat(second)).type === "Directory") candidates.push(second)
        }
      }
    }
    const found: Repository[] = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
      const repo = yield* Effect.catchIf(
        Effect.catchIf(project(candidate), (error) => missing(error), () => Effect.succeed(undefined)),
        (error) => notRepository(error),
        () => Effect.succeed(undefined)
      )
      if (repo && !seen.has(repo.commonDir)) {
        seen.add(repo.commonDir)
        found.push(repo)
      }
    }
    return found
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
    if (worktreeRoot !== undefined && !path.isAbsolute(worktreeRoot)) return yield* fail("Worktree root must be absolute")
    const base = worktreeRoot === undefined ? `${main.path}.worktrees` : path.resolve(worktreeRoot)
    const destination = path.resolve(base, worktreeName ?? branch)
    if (destination === base || !destination.startsWith(`${base}${path.sep}`)) return yield* fail("Worktree name escapes worktree directory")
    const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${path.sep}`)
    for (const checkout of worktrees) {
      if (inside(checkout.path, base) || inside(checkout.path, destination)) {
        return yield* fail(`Worktree root is inside checkout: ${checkout.path}`)
      }
    }
    if (inside(repo.commonDir, base) || inside(repo.commonDir, destination)) return yield* fail(`Worktree root is inside Git directory: ${repo.commonDir}`)
    const forbidden = worktreeRoot === undefined ? [] : yield* Effect.forEach(
      [...worktrees.map((checkout) => checkout.path), repo.commonDir],
      (directory) => Effect.catchIf(fs.stat(directory), (error) => missing(error), () => Effect.succeed(undefined))
    )
    if (forbidden.some((entry) => entry && Option.isNone(entry.ino))) {
      return yield* fail("Cannot verify worktree root filesystem identity")
    }
    // Check from the filesystem root: a configured root can hide a symlink above its final component.
    for (let part = path.parse(destination).root; ; ) {
      const info = yield* Effect.catchIf(fs.lstat(part), (error) => missing(error), () => Effect.succeed(undefined))
      if (info?.type === "SymbolicLink") return yield* fail(`Symlinked worktree path: ${part}`)
      if (worktreeRoot !== undefined && info?.type === "Directory" && Option.isNone(info.ino)) {
        return yield* fail("Cannot verify worktree root filesystem identity")
      }
      const inode = info && Option.getOrUndefined(info.ino)
      if (inode !== undefined && forbidden.some((entry) =>
        entry !== undefined && info !== undefined && entry.dev === info.dev && Option.getOrUndefined(entry.ino) === inode
      )) return yield* fail(`Worktree root aliases a checkout or Git directory: ${part}`)
      if (part === destination) {
        if (info) return yield* fail(`Worktree path already exists: ${part}`)
        break
      }
      if (info && info.type !== "Directory") return yield* fail(`Not a directory: ${part}`)
      part = path.join(part, path.relative(part, destination).split(path.sep)[0])
    }
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
