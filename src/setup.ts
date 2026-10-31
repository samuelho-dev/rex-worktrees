import { randomUUID } from "node:crypto"
import { Effect, FileSystem, Path, Schema, PlatformError } from "effect"
import lua from "../lua/rex-worktrees.lua" with { type: "text" }
import { rex } from "./rex.ts"
import { AppError, RexConfigCheckSchema, type Install } from "./contracts.ts"

const manualRegistration = '-- BEGIN rex-worktrees\nrequire("rex-worktrees").setup()\n-- END rex-worktrees\n'
const managedRegistration = /^-- BEGIN rex-worktrees\nrequire\("rex-worktrees"\)\.setup\(\{ bin = "(?:\\.|[^"\\])*" \}\)\n-- END rex-worktrees\n$/
const marker = "-- rex-worktrees: managed module\n"
const rexBinPlaceholder = "local installed_rex_bin_dir = false"
const fail = (message: string) => Effect.fail(new AppError({ message }))


// The injectable paths and payload let the filesystem regression test avoid Rex and the user's home.
export const installSetup = Effect.fnUntraced(function* ({ source, home, configPath, lua: module, rexBinDir, managedBin }: Install) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (!path.isAbsolute(configPath) || !path.isAbsolute(home) || !path.isAbsolute(source) || !path.isAbsolute(rexBinDir) || (managedBin !== undefined && !path.isAbsolute(managedBin))) return yield* new AppError({ message: "Setup requires absolute paths" })
  if (!module.startsWith(marker)) return yield* new AppError({ message: "Embedded Lua module is missing its install marker" })
  if (!module.startsWith(`${marker}${rexBinPlaceholder}\n`) || module.split(rexBinPlaceholder).length !== 2) return yield* new AppError({ message: "Embedded Lua module must contain exactly one Rex CLI directory placeholder after its marker" })
  const installedLua = module.replace(rexBinPlaceholder, `local installed_rex_bin_dir = ${JSON.stringify(rexBinDir).replace(/\\u00([0-1][0-9a-f])/gi, (_, hex: string) => `\\${parseInt(hex, 16).toString().padStart(3, "0")}`)}`)
  const bin = managedBin ?? path.join(home, ".local", "bin", "rex-worktrees")
  // ponytail: preserve the stable package path in Rex; resolve it only to verify the running binary.
  const registration = managedBin === undefined ? manualRegistration : `-- BEGIN rex-worktrees\nrequire("rex-worktrees").setup({ bin = ${JSON.stringify(managedBin)} })\n-- END rex-worktrees\n`
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
  const current = initInfo ? yield* fs.readFileString(configPath) : ""
  const begin = "-- BEGIN rex-worktrees"
  const end = "-- END rex-worktrees"
  const start = current.indexOf(begin)
  const finish = current.indexOf(end)
  if ((start < 0) !== (finish < 0) || (start >= 0 && (
    current.indexOf(begin, start + begin.length) !== -1 ||
    current.indexOf(end, finish + end.length) !== -1 ||
    (current.slice(start, finish + end.length + 1) !== manualRegistration &&
    !managedRegistration.test(current.slice(start, finish + end.length + 1)))
  ))) return yield* fail(`Malformed rex-worktrees registration in ${configPath}`)
  if (start < 0 && /require\s*\(?\s*["']rex-worktrees["']/.test(current)) return yield* fail(`Existing rex-worktrees registration in ${configPath}; remove it before setup`)
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
  if (managedBin === undefined) {
    if (source !== bin) yield* atomic(bin, temporary => fs.copyFile(source, temporary).pipe(Effect.flatMap(() => fs.chmod(temporary, 0o755))))
    else yield* fs.chmod(bin, 0o755)
  }
  yield* atomic(luaPath, temporary => fs.writeFileString(temporary, installedLua, { flag: "wx", mode: 0o644 }))
  if (start < 0) yield* fs.writeFileString(configPath, `${current && !current.endsWith("\n") ? "\n" : ""}${registration}`, { flag: "a" })
  else if (current.slice(start, finish + end.length + 1) !== registration) yield* fs.writeFileString(configPath, `${current.slice(0, start)}${registration}${current.slice(finish + end.length + 1)}`)
  return { bin, luaPath, configPath }
})

export const setup = Effect.fnUntraced(function* (managedBin?: string) {
  const home = process.env.HOME
  if (!home) return yield* fail("HOME is required")
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
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
  const response = yield* rex(["config", "check", "--json"])
  const checked = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RexConfigCheckSchema))(response)
  if (checked.diagnostics.length) return yield* fail("Rex config has diagnostics; fix it before setup")
  return yield* installSetup({ source: process.execPath, home, configPath: checked.path, lua, rexBinDir, managedBin })
})
