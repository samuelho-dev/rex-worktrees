import { Effect, FileSystem, Path, PlatformError } from "effect"
import * as Git from "./git.ts"
import * as Jj from "./jj.ts"
import type { Repository } from "./contracts.ts"

const missing = (error: unknown) => PlatformError.isPlatformError(error) && error.reason._tag === "NotFound"

const backend = Effect.fnUntraced(function*(input: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const canonical = yield* fs.realPath(input)
  let current = (yield* fs.stat(canonical)).type === "Directory" ? canonical : path.dirname(canonical)
  for (;;) {
    // The nearest marker wins. At a colocated root JJ owns the repository, never its backing Git store.
    if (yield* fs.lstat(path.join(current, ".jj")).pipe(Effect.map(() => true), Effect.catchIf(missing, () => Effect.succeed(false)))) return "jj" as const
    if (yield* fs.lstat(path.join(current, ".git")).pipe(Effect.map(() => true), Effect.catchIf(missing, () => Effect.succeed(false)))) return "git" as const
    const parent = path.dirname(current)
    if (parent === current) return "git" as const
    current = parent
  }
})

export const repository = Effect.fnUntraced(function*(input: string) {
  return (yield* backend(input)) === "jj" ? yield* Jj.repository(input) : yield* Git.repository(input)
})

export const project = Effect.fnUntraced(function*(input: string) {
  return (yield* backend(input)) === "jj" ? yield* Jj.project(input) : yield* Git.project(input)
})

export const discoverProjects = Effect.fnUntraced(function*(roots: readonly string[], explicitProjects: readonly string[], contextPath?: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const candidates = [...(contextPath ? [contextPath] : []), ...explicitProjects]
  for (const root of roots) {
    if (!(yield* fs.exists(root))) continue
    candidates.push(root)
    // ponytail: two levels only; glob uses directory-entry types instead of statting every file.
    const markers = yield* fs.glob("{*,*/*}/{.git,.jj}", { root, dot: true })
    candidates.push(...markers.map(marker => path.join(root, path.dirname(marker))))
  }
  const found: Repository[] = []
  const seen = new Set<string>()
  const inspected = yield* Effect.forEach(new Set(candidates), candidate =>
    project(candidate).pipe(
      Effect.catchIf(error => missing(error) || Git.notRepository(error), () => Effect.succeed(undefined))
    ), { concurrency: 4 })
  for (const repo of inspected) {
    if (repo && !seen.has(`${repo.vcs}\0${repo.commonDir}`)) {
      seen.add(`${repo.vcs}\0${repo.commonDir}`)
      found.push(repo)
    }
  }
  return found
})
