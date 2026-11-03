import { randomUUID } from "node:crypto"
import { Effect, FileSystem, Path, Schema, PlatformError } from "effect"
import lua from "../lua/rex-worktrees.lua" with { type: "text" }
import { rex } from "./rex.ts"
import { AppError, ConfigSchema, RexConfigCheckSchema, type Install } from "./contracts.ts"

const manualRegistration = '-- BEGIN rex-worktrees\nrequire("rex-worktrees").setup()\n-- END rex-worktrees\n'
const managedRegistration = /^-- BEGIN rex-worktrees\nrequire\("rex-worktrees"\)\.setup\(\{ bin = "(?:\\.|[^"\\])*" \}\)\n-- END rex-worktrees\n$/
const marker = "-- rex-worktrees: managed module\n"
const placeholders = [
  "local installed_rex_bin_dir = false",
  "local installed_path_env = false",
  "local installed_bin = false",
  "local installed_config_dir = false"
]
const luaLiteral = (value: string) => JSON.stringify(value).replace(/\\u00([0-1][0-9a-f])/gi,
  (_, hex: string) => `\\${parseInt(hex, 16).toString().padStart(3, "0")}`)
const fail = (message: string) => Effect.fail(new AppError({ message }))


// The injectable paths and payload let the filesystem regression test avoid Rex and the user's home.
export const installSetup = Effect.fnUntraced(function*({ source, home, configPath, lua: module, rexBinDir, managedBin, pathEnv, legacyConfigPath, allowLinkedConfig = true }: Install) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (!path.isAbsolute(configPath) || !path.isAbsolute(home) || !path.isAbsolute(source) || !path.isAbsolute(rexBinDir) || (managedBin !== undefined && !path.isAbsolute(managedBin)) || (legacyConfigPath !== undefined && !path.isAbsolute(legacyConfigPath))) return yield* new AppError({ message: "Setup requires absolute paths" })
  const header = `${marker}${placeholders.join("\n")}\n`
  if (!module.startsWith(header) || placeholders.some(placeholder => module.split(placeholder).length !== 2))
    return yield* new AppError({ message: "Embedded Lua module must contain exactly four install placeholders in order after its marker" })
  const bin = managedBin ?? path.join(home, ".local", "bin", "rex-worktrees")
  const values = [rexBinDir, pathEnv, bin, path.dirname(configPath)]
  const installedLua = placeholders.reduce((text, placeholder, index) => text.replace(placeholder,
    placeholder.replace("false", values[index] === undefined ? "false" : luaLiteral(values[index]))), module)
  // ponytail: a stable embedded executable lets user-owned setup({...}) stay untouched on upgrades.
  const registration = manualRegistration
  const luaPath = path.join(path.dirname(configPath), "rex-worktrees.lua")
  const info = (filename: string) => Effect.catchIf(
    fs.lstat(filename),
    (error) => PlatformError.isPlatformError(error) && error.reason._tag === "NotFound",
    () => Effect.succeed(undefined)
  )
  const binaryInfo = managedBin === undefined ? yield* info(bin) : undefined
  const luaInfo = yield* info(luaPath)
  if (binaryInfo && binaryInfo.type !== "File") return yield* fail(`Refusing to replace non-file binary: ${bin}`)
  if (luaInfo && luaInfo.type !== "File") return yield* fail(`Refusing to replace non-file Lua module: ${luaPath}`)
  if (luaInfo && !(yield* fs.readFileString(luaPath)).startsWith(marker)) return yield* fail(`Refusing to replace unrelated Lua module: ${luaPath}`)
  const initInfo = yield* info(configPath)
  if (initInfo && initInfo.type !== "File" && initInfo.type !== "SymbolicLink") return yield* fail(`Rex init is not a file: ${configPath}`)
  if (initInfo?.type === "SymbolicLink" && !allowLinkedConfig) return yield* fail(`Refusing linked Rex init: ${configPath}`)
  const current = initInfo ? yield* fs.readFileString(configPath) : ""
  const begin = "-- BEGIN rex-worktrees\n"
  const end = "-- END rex-worktrees\n"
  const start = current.indexOf(begin)
  const finish = current.indexOf(end)
  if ((start < 0) !== (finish < 0) || (start >= 0 && (
    current.indexOf(begin, start + begin.length) !== -1 ||
    current.indexOf(end, finish + end.length) !== -1 ||
    finish <= start ||
    (start > 0 && current[start - 1] !== "\n")
  ))) return yield* fail(`Malformed rex-worktrees registration in ${configPath}`)
  const existing = start < 0 ? undefined : current.slice(start, finish + end.length)
  if (existing !== undefined && !(
    existing === manualRegistration ||
    managedRegistration.test(existing) ||
    /require\s*\(?\s*["']rex-worktrees["']\s*\)?\.setup\s*\(/.test(existing)
  )) return yield* fail(`Malformed rex-worktrees registration in ${configPath}`)
  if (start < 0 && /require\s*\(?\s*["']rex-worktrees["']/.test(current)) return yield* fail(`Existing rex-worktrees registration in ${configPath}; remove it before setup`)
  const simple = existing === undefined || existing === manualRegistration || (existing !== undefined && managedRegistration.test(existing))
  const legacyInfo = legacyConfigPath === undefined ? undefined : yield* info(legacyConfigPath)
  if (legacyInfo && legacyInfo.type !== "File") return yield* fail(`Refusing non-file legacy settings: ${legacyConfigPath}`)
  if (legacyInfo && !simple) return yield* fail(`Cannot merge legacy settings ${legacyConfigPath} with custom Rex registration in ${configPath}. Move roots/projects/worktreeRoot into require("rex-worktrees").setup({...}) manually, back up and remove the legacy JSON file, then rerun setup.`)
  const legacyBytes = legacyInfo ? yield* fs.readFileString(legacyConfigPath!) : undefined
  const legacy = legacyBytes === undefined ? undefined : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigSchema))(legacyBytes)
  const expand = (value: string) => value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(path.dirname(legacyConfigPath!), value)
  const legacyRegistration = legacy === undefined ? undefined : `-- BEGIN rex-worktrees\nrequire("rex-worktrees").setup({${[
    legacy.roots?.length ? `roots = { ${legacy.roots.map(root => luaLiteral(expand(root))).join(", ")} }` : undefined,
    legacy.projects?.length ? `projects = { ${legacy.projects.map(project => typeof project === "string"
      ? luaLiteral(expand(project))
      : `{ path = ${luaLiteral(expand(project.path))}${project.worktreeRoot === undefined ? "" : `, worktreeRoot = ${luaLiteral(expand(project.worktreeRoot))}`} }`).join(", ")} }` : undefined,
    legacy.worktreeRoot === undefined ? undefined : `worktreeRoot = ${luaLiteral(expand(legacy.worktreeRoot))}`
  ].filter(value => value !== undefined).join(", ")
    } })\n-- END rex-worktrees\n`
  const nextRegistration = legacyRegistration ?? (simple ? registration : existing!)
  const backup = legacyConfigPath === undefined ? undefined : `${legacyConfigPath}.backup`
  if (legacy && (yield* info(backup!))) return yield* fail(`Legacy settings backup already exists: ${backup}; preserve or move it before setup`)
  const sourceInfo = yield* fs.stat(source)
  if (sourceInfo.type !== "File") return yield* fail(`Installer source is not a file: ${source}`)
  if (managedBin !== undefined) {
    const target = yield* info(managedBin)
    if (!target) return yield* fail(`Managed binary does not exist: ${managedBin}`)
    const managedInfo = yield* fs.stat(managedBin)
    if (managedInfo.type !== "File" || (managedInfo.mode & 0o111) === 0) return yield* fail(`Managed binary must be an executable file: ${managedBin}`)
    if ((yield* fs.realPath(managedBin)) !== (yield* fs.realPath(source))) return yield* fail(`Managed binary must resolve to the running executable: ${managedBin}`)
  } else yield* fs.makeDirectory(path.dirname(bin), { recursive: true })
  yield* fs.makeDirectory(path.dirname(luaPath), { recursive: true })
  const atomic = Effect.fnUntraced(function*<E, R>(destination: string, write: (temporary: string) => Effect.Effect<void, E, R>) {
    const temporary = path.join(path.dirname(destination), `.rex-worktrees-${randomUUID()}.tmp`)
    return yield* write(temporary).pipe(
      Effect.flatMap(() => fs.rename(temporary, destination)),
      Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore))
    )
  })
  if (legacyBytes !== undefined) yield* fs.writeFileString(backup!, legacyBytes, { flag: "wx" })
  if (managedBin === undefined) {
    if (source !== bin) yield* atomic(bin, temporary => fs.copyFile(source, temporary).pipe(Effect.flatMap(() => fs.chmod(temporary, 0o755))))
    else yield* fs.chmod(bin, 0o755)
  }
  yield* atomic(luaPath, temporary => fs.writeFileString(temporary, installedLua, { flag: "wx", mode: 0o644 }))
  if (start < 0) yield* fs.writeFileString(configPath, `${current && !current.endsWith("\n") ? "\n" : ""}${nextRegistration}`, { flag: "a" })
  else if (existing !== nextRegistration) yield* fs.writeFileString(configPath, `${current.slice(0, start)}${nextRegistration}${current.slice(finish + end.length)}`)
  if (legacy) yield* fs.remove(legacyConfigPath!)
  return { bin, luaPath, configPath, migrated: legacy !== undefined }
})

export const setup = Effect.fnUntraced(function*(managedBin?: string, configPath?: string) {
  const home = process.env.HOME
  if (!home) return yield* fail("HOME is required")
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (configPath !== undefined && !path.isAbsolute(configPath)) return yield* fail(`--config must be an absolute path: ${configPath}`)
  const executable = (dir: string) => Effect.catchIf(
    fs.stat(path.join(dir, "rex")).pipe(Effect.map(info => info.type === "File" && (info.mode & 0o111) !== 0)),
    (error) => PlatformError.isPlatformError(error) && error.reason._tag === "NotFound",
    () => Effect.succeed(false)
  )
  const configured = process.env.REX_BIN_DIR
  let rexBinDir: string | undefined
  if (configured) {
    if (!path.isAbsolute(configured) || !(yield* executable(configured))) return yield* fail(`REX_BIN_DIR must be an absolute directory containing an executable rex: ${configured}`)
    rexBinDir = configured
  } else {
    for (const entry of (process.env.PATH ?? "").split(":")) {
      if (entry && (yield* executable(entry))) {
        rexBinDir = path.resolve(entry)
        break
      }
    }
  }
  if (!rexBinDir) return yield* fail("Rex CLI not found: set REX_BIN_DIR or add an executable rex to PATH")
  // ponytail: an explicit config installs into a stopped Rex instance without asking its server to start.
  let target = configPath
  if (target === undefined) {
    const response = yield* rex(["config", "check", "--json"])
    const checked = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RexConfigCheckSchema))(response)
    if (checked.diagnostics.length) return yield* fail("Rex config has diagnostics; fix it before setup")
    target = checked.path
  }
  return yield* installSetup({ source: process.execPath, home, configPath: target, lua, rexBinDir, managedBin, allowLinkedConfig: configPath === undefined, ...(configPath === undefined ? { legacyConfigPath: path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "rex-worktrees", "config.json") } : {}), ...(process.env.PATH !== undefined ? { pathEnv: process.env.PATH } : {}) })
})
