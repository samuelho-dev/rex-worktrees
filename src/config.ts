import { Effect, FileSystem, Path, Schema } from "effect"
import { missing, notRepository, project, repository } from "./git.ts"
import { AppError, ConfigSchema, type ResolvedConfig } from "./contracts.ts"


export const loadConfig = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = process.env.HOME
  if (!home) return yield* new AppError({ message: "HOME is required" })
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
  if (!path.isAbsolute(configHome)) return yield* new AppError({ message: "Config home must be absolute" })
  const filename = path.join(configHome, "rex-worktrees", "config.json")
  const exists = yield* fs.exists(filename)
  const values = exists
    ? yield* fs.readFileString(filename).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigSchema))))
    : { roots: undefined, projects: undefined, worktreeRoot: undefined }
  const expand = (value: string) => {
    const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value
    return path.resolve(path.dirname(filename), expanded)
  }
  const config: ResolvedConfig = {
    roots: (values.roots ?? []).map(expand),
    projects: (values.projects ?? []).map((entry) => expand(typeof entry === "string" ? entry : entry.path)),
    worktreeRoot: values.worktreeRoot === undefined ? undefined : expand(values.worktreeRoot),
    projectRoots: (values.projects ?? []).flatMap((entry) => typeof entry === "string" || entry.worktreeRoot === undefined
      ? [] : [{ path: expand(entry.path), worktreeRoot: expand(entry.worktreeRoot) }])
  }
  return config
})

export const resolveWorktreeRoot = Effect.fnUntraced(function*(repoPath: string) {
  const config = yield* loadConfig
  const target = yield* project(repoPath)
  for (const entry of config.projectRoots) {
    const candidate = yield* Effect.catchIf(
      Effect.catchIf(repository(entry.path), (error) => missing(error), () => Effect.succeed(undefined)),
      (error) => notRepository(error),
      () => Effect.succeed(undefined)
    )
    if (candidate?.commonDir === target.commonDir) return entry.worktreeRoot
  }
  const path = yield* Path.Path
  return config.worktreeRoot === undefined ? undefined : path.join(config.worktreeRoot, target.name)
})
