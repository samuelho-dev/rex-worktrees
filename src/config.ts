import { Effect, Path, Schema } from "effect"
import { repository, project } from "./repositories.ts"
import { missing, notRepository } from "./git.ts"
import { AppError, NativeConfigSchema, RexNativeConfigResponseSchema, type ResolvedConfig } from "./contracts.ts"
import { rememberedCloneRoot } from "./state.ts"
import { rex } from "./rex.ts"



export const loadConfig = Effect.gen(function*() {
  const path = yield* Path.Path
  const raw = process.env.REX_WORKTREES_CONFIG
  const { config: values, directory } = raw === undefined
    ? yield* rex(["do", "worktrees_config", "--json"]).pipe(
      Effect.mapError(() => new AppError({ message: "Native Rex worktrees_config is unavailable; register rex-worktrees.setup in this machine's Rex config and reload it" })),
      Effect.flatMap((response) => Schema.decodeUnknownEffect(RexNativeConfigResponseSchema)(response))
    )
    : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(NativeConfigSchema))(raw)
  if (!path.isAbsolute(directory) || directory.includes("\0")) {
    return yield* new AppError({ message: "Native Rex config directory must be an absolute path" })
  }
  const home = process.env.HOME
  if (!home || !path.isAbsolute(home)) return yield* new AppError({ message: "HOME must be an absolute directory" })
  const expand = (value: string) => {
    const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value
    return path.resolve(directory, expanded)
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
export const resolveCloneRoot = Effect.fnUntraced(function*(roots: readonly string[], projects: readonly { path: string }[], stateRoot?: string) {
  const path = yield* Path.Path
  if (roots[0]) return roots[0]
  const remembered = yield* rememberedCloneRoot(stateRoot)
  if (remembered) return remembered
  const parents = new Set(projects.map(project => path.dirname(project.path)))
  if (parents.size === 1) return [...parents][0]!
  const home = process.env.HOME
  if (!home || !path.isAbsolute(home)) return yield* new AppError({ message: "Target HOME must be an absolute directory" })
  return home
})


export const resolveWorktreeRoot = Effect.fnUntraced(function*(repoPath: string) {
  const config = yield* loadConfig
  const target = yield* project(repoPath)
  for (const entry of config.projectRoots) {
    const candidate = yield* repository(entry.path).pipe(
      Effect.catchIf(error => missing(error) || notRepository(error), () => Effect.succeed(undefined))
    )
    if (candidate?.vcs === target.vcs && candidate.commonDir === target.commonDir) return entry.worktreeRoot
  }
  const path = yield* Path.Path
  return config.worktreeRoot === undefined ? undefined : path.join(config.worktreeRoot, target.name)
})
