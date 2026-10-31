import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { CommandError, type Environment } from "./contracts.ts"

export const run = Effect.fnUntraced(function*(program: string, args: readonly string[], cwd?: string, env?: Environment) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make(program, [...args], { cwd, env }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode
    ], { concurrency: "unbounded" })
    if (exitCode !== 0) {
      return yield* Effect.fail(new CommandError({ message: `${program} ${args.join(" ")} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`, program, args, exitCode, stdout, stderr }))
    }
    return stdout
  }))
})
