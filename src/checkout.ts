import { Effect, FileSystem, Option, Path, PlatformError } from "effect"
import { AppError } from "./contracts.ts"

const fail = (message: string) => Effect.fail(new AppError({ message }))
const missing = (error: unknown) => PlatformError.isPlatformError(error) && error.reason._tag === "NotFound"

export const planCheckoutPath = Effect.fnUntraced(function*(primaryPath: string, metadataDirectories: readonly string[], checkoutPaths: readonly string[], name: string, worktreeRoot?: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (worktreeRoot !== undefined && !path.isAbsolute(worktreeRoot)) return yield* fail("Worktree root must be absolute")
  const base = worktreeRoot === undefined ? `${primaryPath}.worktrees` : path.resolve(worktreeRoot)
  const destination = path.resolve(base, name)
  if (destination === base || !destination.startsWith(`${base}${path.sep}`)) return yield* fail("Worktree name escapes worktree directory")
  const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${path.sep}`)
  for (const checkout of checkoutPaths) {
    if (inside(checkout, base) || inside(checkout, destination)) return yield* fail(`Worktree root is inside checkout: ${checkout}`)
  }
  for (const metadata of metadataDirectories) {
    if (inside(metadata, base) || inside(metadata, destination)) return yield* fail(`Worktree root is inside metadata directory: ${metadata}`)
  }
  const forbidden = worktreeRoot === undefined ? [] : yield* Effect.forEach(
    [...checkoutPaths, ...metadataDirectories],
    (directory) => Effect.catchIf(fs.stat(directory), missing, () => Effect.succeed(undefined))
  )
  if (forbidden.some((entry) => entry && Option.isNone(entry.ino))) return yield* fail("Cannot verify worktree root filesystem identity")
  // ponytail: inspect ancestors once; lexical containment alone misses symlink and inode aliases.
  for (let part = path.parse(destination).root; ; ) {
    const info = yield* Effect.catchIf(fs.lstat(part), missing, () => Effect.succeed(undefined))
    if (info?.type === "SymbolicLink") return yield* fail(`Symlinked worktree path: ${part}`)
    if (worktreeRoot !== undefined && info?.type === "Directory" && Option.isNone(info.ino)) return yield* fail("Cannot verify worktree root filesystem identity")
    const inode = info && Option.getOrUndefined(info.ino)
    if (inode !== undefined && forbidden.some((entry) => entry !== undefined && info !== undefined && entry.dev === info.dev && Option.getOrUndefined(entry.ino) === inode)) {
      return yield* fail(`Worktree root aliases a checkout or metadata directory: ${part}`)
    }
    if (part === destination) {
      if (info) return yield* fail(`Worktree path already exists: ${part}`)
      break
    }
    if (info && info.type !== "Directory") return yield* fail(`Not a directory: ${part}`)
    part = path.join(part, path.relative(part, destination).split(path.sep)[0])
  }
  return destination
})
