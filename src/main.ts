import { isAbsolute, resolve } from "node:path"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Schema } from "effect"
import { connectMachine, listMachines, review, submit } from "./client.ts"
import { AppError, BlockIdSchema, ClientIdSchema, CliBooleanFlagSchema, CliStringFlagSchema, SessionIdSchema, TaskRequestSchema, type CliFlags, type LaunchInput, type PopupOrigin } from "./contracts.ts"
import { hostRequest } from "./host.ts"
import { closeManagedPopup, openPopup, originDirectory } from "./rex.ts"
import { setup } from "./setup.ts"
import { popup } from "./ui.ts"
import { task } from "./worktrees.ts"
// Replaced by `bun build --define`; undefined in source-mode Bun.
declare const REX_WORKTREES_COMPILED: boolean
const compiled = typeof REX_WORKTREES_COMPILED !== "undefined" && REX_WORKTREES_COMPILED

const help = `rex-worktrees — Git worktrees on existing Rex machines
  setup [--bin /absolute/path/rex-worktrees] install Lua module; copy binary to ~/.local/bin unless --bin is set
  popup [--host HOST] [--context PATH | --no-context] [--origin-session ID [--origin-block ID]] [--origin-client ID]
                                         interactive terminal chooser
  launch-popup [--session ID] [--origin-block ID | --no-context] [--origin-client ID] [--host HOST]
                                         open a floating chooser in the source window
  open --repo PATH --session ID --name NAME (--branch NAME | --worktree PATH)
       [--worktree-name NAME (branch only)] [--host HOST] [--client ID] [--additional | --split]
  host-request                            read a JSON request on stdin, write a JSON response
  help

--host selects an existing Rex host label or registry ID. Install setup separately on each destination.`

const executable = compiled ? [process.execPath] : [process.execPath, import.meta.path]

const parseFlags = Effect.fnUntraced(function* (args: readonly string[]) {
  const flags: CliFlags = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (Schema.is(CliBooleanFlagSchema)(flag)) {
      if (flag in flags) return yield* Effect.fail(new AppError({ message: `Duplicate flag: ${flag}` }))
      flags[flag] = true
    } else if (Schema.is(CliStringFlagSchema)(flag)) {
      if (flag in flags) return yield* Effect.fail(new AppError({ message: `Duplicate flag: ${flag}` }))
      const value = args[++i]
      if (!value || value.startsWith("--")) return yield* Effect.fail(new AppError({ message: `Missing value for ${flag}` }))
      if (flag === "--session" || flag === "--origin-session") flags[flag] = yield* Schema.decodeUnknownEffect(SessionIdSchema)(value)
      else if (flag === "--client" || flag === "--origin-client") flags[flag] = yield* Schema.decodeUnknownEffect(ClientIdSchema)(value)
      else if (flag === "--origin-block") flags[flag] = yield* Schema.decodeUnknownEffect(BlockIdSchema)(value)
      else flags[flag] = value
    } else return yield* Effect.fail(new AppError({ message: `Unknown flag: ${flag}` }))
  }
  return flags
})

const main = Effect.gen(function* () {
  const argv = process.argv.slice(2)
  const [verb = "help", ...args] = argv
  if (verb === "help" || verb === "--help" || verb === "-h") { yield* Console.log(help); return }
  if (verb === "setup") {
    const flags = yield* parseFlags(args)
    if (Object.keys(flags).some(key => key !== "--bin")) return yield* Effect.fail(new AppError({ message: "Invalid setup flags" }))
    if (!compiled) return yield* Effect.fail(new AppError({ message: "Build first with bun run build, then run ./dist/rex-worktrees setup" }))
    const installed = yield* setup(flags["--bin"])
    yield* Console.log(`${flags["--bin"] ? "Registered binary" : "Installed binary"}: ${installed.bin}\nInstalled Lua module: ${installed.luaPath}\nUpdated Rex config: ${installed.configPath}\nRun rex config reload to activate.`)
    return
  }
  if (verb === "popup") {
    const flags = yield* parseFlags(args)
    if (Object.keys(flags).some(key => !["--host", "--context", "--origin-session", "--origin-block", "--origin-client", "--no-context", "--managed-popup"].includes(key))) {
      return yield* Effect.fail(new AppError({ message: "Invalid popup flags" }))
    }
    if (flags["--context"] && flags["--no-context"]) return yield* Effect.fail(new AppError({ message: "--context and --no-context are mutually exclusive" }))
    if (flags["--origin-block"] && !flags["--origin-session"]) return yield* Effect.fail(new AppError({ message: "--origin-block requires --origin-session" }))
    const envSession = process.env.REX_SESSION === undefined ? undefined : yield* Schema.decodeUnknownEffect(SessionIdSchema)(process.env.REX_SESSION)
    const sessionId = flags["--origin-session"] ?? envSession
    const blockId = flags["--origin-block"]
      ?? (!flags["--no-context"] && sessionId === envSession && process.env.REX_BLOCK !== undefined ? yield* Schema.decodeUnknownEffect(BlockIdSchema)(process.env.REX_BLOCK) : undefined)
    const origin: PopupOrigin = {
      sessionId,
      blockId,
      clientId: flags["--origin-client"] ?? (process.env.REX_CLIENT === undefined ? undefined : yield* Schema.decodeUnknownEffect(ClientIdSchema)(process.env.REX_CLIENT))
    }
    const context = typeof flags["--context"] === "string" ? Effect.succeed(resolve(flags["--context"]))
      : flags["--no-context"] ? Effect.succeed(undefined)
      : args.length && sessionId && blockId ? originDirectory(sessionId, blockId)
      : Effect.succeed(process.cwd())
    yield* popup(executable, context, origin, flags["--host"])
    if (flags["--managed-popup"]) yield* closeManagedPopup
    return
  }
  if (verb === "launch-popup") {
    const flags = yield* parseFlags(args)
    if (Object.keys(flags).some(key => !["--session", "--host", "--origin-block", "--origin-client", "--no-context"].includes(key))) {
      return yield* Effect.fail(new AppError({ message: "Invalid launch-popup flags" }))
    }
    if (flags["--origin-block"] && flags["--no-context"]) return yield* Effect.fail(new AppError({ message: "--origin-block and --no-context are mutually exclusive" }))
    const envSession = process.env.REX_SESSION === undefined ? undefined : yield* Schema.decodeUnknownEffect(SessionIdSchema)(process.env.REX_SESSION)
    const sessionId = flags["--session"] || envSession
    if (!sessionId) return yield* Effect.fail(new AppError({ message: "Specify --session ID or run inside a Rex terminal" }))
    const blockId = flags["--origin-block"]
      ?? (sessionId === envSession && process.env.REX_BLOCK !== undefined ? yield* Schema.decodeUnknownEffect(BlockIdSchema)(process.env.REX_BLOCK) : undefined)
    const clientId = flags["--origin-client"]
      ?? (sessionId === envSession && process.env.REX_CLIENT !== undefined ? yield* Schema.decodeUnknownEffect(ClientIdSchema)(process.env.REX_CLIENT) : undefined)
    const selected = flags["--host"]
    if (selected && !(yield* listMachines).some(machine => machine.key === selected || machine.label === selected || machine.selector === selected)) return yield* Effect.fail(new AppError({ message: `Rex host ${selected} is not registered` }))
    // Palette context comes from the explicit origin pane; a direct CLI launch keeps its cwd.
    const palette = typeof flags["--origin-block"] === "string"
    const command = [...executable, "popup", "--origin-session", sessionId]
    if (palette && blockId) command.push("--origin-block", blockId)
    else if (flags["--no-context"]) command.push("--no-context")
    else command.push("--context", process.cwd())
    if (selected) command.push("--host", selected)
    yield* Console.log(JSON.stringify(yield* openPopup(command, sessionId, { blockId, clientId })))
    return
  }
  if (verb === "open") {
    if (args.some(arg => ["--context", "--origin-session", "--origin-block", "--origin-client", "--no-context", "--managed-popup"].includes(arg))) {
      return yield* Effect.fail(new AppError({ message: "Context flags are only supported by popup" }))
    }
    const flags = yield* parseFlags(args)
    if (flags["--bin"] !== undefined) return yield* Effect.fail(new AppError({ message: "--bin is only supported by setup" }))
    if (!flags["--repo"] || !flags["--session"] || !flags["--name"]) return yield* Effect.fail(new AppError({ message: "open requires --repo PATH --session ID --name NAME" }))
    if (Boolean(flags["--branch"]) === Boolean(flags["--worktree"])) return yield* Effect.fail(new AppError({ message: "Choose exactly one of --branch NAME or --worktree PATH" }))
    if (flags["--worktree-name"] !== undefined && flags["--worktree"] !== undefined) return yield* Effect.fail(new AppError({ message: "--worktree-name requires --branch, not --worktree" }))
    if (flags["--additional"] && flags["--split"]) return yield* Effect.fail(new AppError({ message: "--additional and --split are mutually exclusive" }))
    const input: LaunchInput = {
      repo: flags["--repo"], sessionId: flags["--session"], name: flags["--name"],
      branch: flags["--branch"], worktreeName: flags["--worktree-name"], path: flags["--worktree"], clientId: flags["--client"],
      additional: flags["--additional"], split: flags["--split"]
    }
    if (!input.repo.trim() || !input.name.trim() || !input.sessionId.trim()) return yield* Effect.fail(new AppError({ message: "Required values cannot be blank" }))
    const selected = flags["--host"]
    const machine = (yield* listMachines).find(machine => !selected ? machine.local : machine.key === selected || machine.label === selected || machine.selector === selected)
    if (!machine) return yield* Effect.fail(new AppError({ message: `Rex host ${selected} is not registered` }))
    const host = yield* connectMachine(machine)
    if (!host.local && (!isAbsolute(input.repo) || (input.path && !isAbsolute(input.path)))) return yield* Effect.fail(new AppError({ message: "Remote repository and worktree paths must be absolute on the destination machine" }))
    const launchInput = { ...input, repo: host.local ? resolve(input.repo) : input.repo, path: input.path && (host.local ? resolve(input.path) : input.path) }
    const reviewed = yield* review(host, executable, launchInput)
    yield* Console.log(JSON.stringify(yield* submit(host, executable, launchInput, reviewed), null, 2))
    return
  }
  if (verb === "task") {
    if (args.length !== 1) return yield* Effect.fail(new AppError({ message: "task requires one JSON argument" }))
    const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TaskRequestSchema))(args[0])
    yield* task(request)
    return
  }
  if (verb === "host-request") {
    if (args.length) return yield* Effect.fail(new AppError({ message: "host-request reads JSON from stdin" }))
    const raw = yield* Effect.tryPromise({ try: () => Bun.stdin.text(), catch: cause => new AppError({ message: "Failed reading stdin", cause }) })
    yield* Console.log(JSON.stringify(yield* hostRequest(raw, executable)))
    return
  }
  return yield* Effect.fail(new AppError({ message: `Unknown command: ${verb}\n${help}` }))
})

BunRuntime.runMain(Effect.provide(main, BunServices.layer))
