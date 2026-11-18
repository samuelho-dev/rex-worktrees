import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { MachineSchema, ServerHostIdSchema, SessionIdSchema, SessionSelectionSchema, type CloneInput, type LaunchInput } from "../src/contracts.ts";
import { cloneTask, launch, launchClone, planClone, planLaunch } from "../src/worktrees.ts";
import { connectMachine } from "../src/client.ts";
import { hostRequest } from "../src/host.ts";

it.live("reviews use fresh operation snapshots and launch tasks only after final review", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(async () => realpath(await mkdtemp(join(tmpdir(), "rex-named-session-"))));
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const log = join(root, "rex-log.jsonl");
    const previous = Object.fromEntries(["REX_BIN_DIR", "REX_WORKTREES_LOCAL_ENDPOINT", "REX_TEST_LOG", "REX_TEST_REMOTE_ENDPOINT", "REX_TEST_REGISTERED_ENDPOINT", "REX_TEST_REMOTE_HOST", "REX_TEST_BLOCK_MODE", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "HOME", "REX_SESSION", "REX_BLOCK", "SHELL"].map(key => [key, process.env[key]]));
    try {
      process.env.HOME = root;
      process.env.XDG_CONFIG_HOME = join(root, "config");
      const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
      yield* Effect.promise(() => mkdir(bin));
      const init = Bun.spawnSync(["git", "init", "-b", "main", repo], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
      if (init.exitCode !== 0) throw new Error(new TextDecoder().decode(init.stderr));
      yield* Effect.promise(() => writeFile(join(repo, "tracked"), "base\n"));
      for (const args of [["add", "tracked"], ["-c", "user.name=Rex Tests", "-c", "user.email=rex@example.test", "commit", "-m", "base"]]) {
        const result = Bun.spawnSync(["git", "-C", repo, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      }
      const bare = join(root, "origin.git");
      const bareClone = Bun.spawnSync(["git", "clone", "--bare", repo, bare], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
      if (bareClone.exitCode !== 0) throw new Error(new TextDecoder().decode(bareClone.stderr));
      const native = join(bin, "rex");
      yield* Effect.promise(() => writeFile(native, `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const at = args.indexOf("--autostart=false") + 1;
const tail = args.slice(at);
const cmd = tail[0] === "--timeout" ? tail.slice(2) : tail;
const remote = args[args.indexOf("-S") + 1] === "Remote";
appendFileSync(process.env.REX_TEST_LOG, JSON.stringify(cmd) + "\\n");
let result;
const created = (readFileSync(process.env.REX_TEST_LOG, "utf8").match(/"session.create"/g) || []).length;
if (cmd[0] === "whoami") result = remote
  ? { host_id: process.env.REX_TEST_REMOTE_HOST || "remote-host", endpoint: process.env.REX_TEST_REMOTE_ENDPOINT || "unix:///remote-one", principal: { transport: "unix" } }
  : { host_id: "fixture-host", endpoint: "unix:///fixture.sock", principal: { transport: "unix" } };
else if (cmd[0] === "hosts" && cmd[1] === "list") result = { home: { label: "Local", endpoint: "unix:///fixture.sock", this_machine: true },
  hosts: [{ host: { id: "remote-id", label: "Remote", endpoints: [process.env.REX_TEST_REGISTERED_ENDPOINT || process.env.REX_TEST_REMOTE_ENDPOINT || "unix:///remote-one"] } }] };
else if (cmd[0] === "actions") result = { actions: [{ name: "worktrees_request", args: { properties: { request: { type: "string" } } } }] };
else if (cmd[0] === "ls") result = { sessions: [{ session_id: "old-id", label: "Same label" },
  ...Array.from({ length: created }, (_, index) => ({ session_id: "created-" + (index + 1), label: "Same label" }))] };
else if (cmd.includes("client.list")) result = { clients: [] };
else if (cmd[0] === "do" && cmd[1] === "worktrees_config") result = JSON.stringify({ config: {}, directory: process.env.XDG_CONFIG_HOME + "/rex" });
else if (cmd.includes("session.create")) result = { session_id: "created-" + created, initial_windows: [{ window_id: "new-window", block_ids: ["new-block"] }] };
else if (cmd.includes("session.list_blocks")) result = { blocks: cmd.includes("old-id")
  ? [{ block_id: "dead", host_id: "fixture-host", placement: "placed", window_id: "reuse-window" },
     { block_id: "live", host_id: "fixture-host", placement: "placed", window_id: process.env.REX_TEST_BLOCK_MODE === "moved" ? "other-window" : "reuse-window" }]
  : cmd.includes("created-2") ? [{ block_id: "new-block", host_id: "fixture-host", placement: "placed", window_id: "new-window" }] : [] };
else if (cmd.at(-1) === "process") result = { last_exit: cmd.includes("dead") ? { exit_code: 0 } : null, foreground: { cwd: ${JSON.stringify(repo)} } };
else if (cmd.at(-1) === "pwd") result = { pwd: ${JSON.stringify(repo)} };
else if (cmd.includes("session.focus_block")) result = {};
else { console.error("Unexpected Rex call: " + cmd.join(" ")); process.exit(1); }
console.log(JSON.stringify(result));
`));
      yield* Effect.promise(() => chmod(native, 0o755));
      process.env.REX_BIN_DIR = bin;
      process.env.REX_WORKTREES_LOCAL_ENDPOINT = "unix:///fixture.sock";
      process.env.REX_TEST_LOG = log;
      process.env.XDG_STATE_HOME = join(root, "state");
      const hostId = Schema.decodeUnknownSync(ServerHostIdSchema)("fixture-host");
      const input: LaunchInput = { vcs: "git", repo, path: repo, name: "Task", session: { kind: "new", name: "Same label" } };
      process.env.REX_TEST_REMOTE_ENDPOINT = "unix:///remote-one";
      process.env.REX_TEST_REMOTE_HOST = "remote-host";
      delete process.env.REX_TEST_REGISTERED_ENDPOINT;
      delete process.env.REX_TEST_BLOCK_MODE;
      const remoteMachine = yield* Schema.decodeEffect(MachineSchema)({ key: "remote-id", label: "Remote", local: false, selector: "Remote" });
      expect((yield* connectMachine(remoteMachine)).hostId).toBe("remote-host");
      expect((yield* Effect.promise(() => readFile(log, "utf8"))).match(/"hosts","list"/g)).toHaveLength(1);
      process.env.REX_TEST_REMOTE_ENDPOINT = "unix:///remote-two";
      process.env.REX_TEST_REMOTE_HOST = "remote-host-2";
      expect((yield* connectMachine(remoteMachine)).hostId).toBe("remote-host-2");
      expect((yield* Effect.promise(() => readFile(log, "utf8"))).match(/"hosts","list"/g)).toHaveLength(2);
      process.env.REX_TEST_REGISTERED_ENDPOINT = "unix:///unregistered";
      expect((yield* Effect.flip(connectMachine(remoteMachine))).message).toContain("unexpected server");

      const associationDirectory = join(root, "state", "rex-worktrees", "associations");
      yield* Effect.promise(() => mkdir(join(root, "state", "rex-worktrees"), { recursive: true }));
      yield* Effect.promise(() => writeFile(associationDirectory, "not a directory"));
      expect((yield* planLaunch(input, hostId)).warning).toBeUndefined();
      const reuseInput: LaunchInput = { ...input, session: { kind: "existing", id: SessionIdSchema.make("old-id") } };
      const additional = yield* planLaunch({ ...reuseInput, additional: true }, hostId);
      expect(additional.action).toBe("new-tab");
      expect(additional.target).toBeUndefined();
      expect(additional.warning).toBeUndefined();
      expect((yield* planLaunch(reuseInput, hostId)).warning).toBeDefined();
      yield* Effect.promise(() => rm(associationDirectory));
      yield* Effect.promise(() => mkdir(associationDirectory));
      for (const [index, blockId] of ["dead", "live"].entries()) {
        yield* Effect.promise(() => writeFile(join(associationDirectory, `${index}.json`), JSON.stringify({
          vcs: "git", hostId, commonDir: join(repo, ".git"), path: repo, sessionId: "old-id", windowId: "reuse-window", blockId
        })));
      }
      const beforeReuse = (yield* Effect.promise(() => readFile(log, "utf8"))).match(/"session.list_blocks"/g)?.length ?? 0;
      expect((yield* planLaunch(reuseInput, hostId)).target).toEqual({ windowId: "reuse-window", blockId: "live" });
      process.env.REX_TEST_BLOCK_MODE = "moved";
      expect((yield* planLaunch(reuseInput, hostId)).action).toBe("new-tab");
      expect((yield* Effect.promise(() => readFile(log, "utf8"))).match(/"session.list_blocks"/g)).toHaveLength(beforeReuse + 2);
      yield* Effect.promise(() => rm(associationDirectory, { recursive: true }));

      for (const kind of ["project", "worktrees"]) {
        const inventory = yield* hostRequest(JSON.stringify({ version: 5, hostId, kind, path: repo, repo }), ["/usr/bin/true"]);
        if (inventory.kind !== "project" && inventory.kind !== "worktrees") throw new Error("Expected checkout inventory");
        expect(inventory.worktrees).toMatchObject([{ vcs: "git", path: repo, branch: "main" }]);
        expect(inventory.branches).toContain("main");
        expect(inventory.revisions).toEqual([]);
      }
      const reviewed = yield* planLaunch(input, hostId);
      expect(reviewed.action).toBe("new-tab");
      yield* planLaunch(input, hostId);
      expect((yield* Effect.promise(() => readFile(log, "utf8"))).includes("session.create")).toBe(false);
      const stale = yield* Effect.flip(launch({ ...input, session: { kind: "new", name: "Changed" } }, ["/usr/bin/true"], reviewed, hostId));
      expect(stale.message).toContain("changed since review");
      const wrongHost = Schema.decodeUnknownSync(ServerHostIdSchema)("wrong-host");
      yield* Effect.flip(launch(input, ["/usr/bin/true"], reviewed, wrongHost));
      yield* Effect.flip(planLaunch({ ...input, session: { kind: "new", name: " " } }, hostId));
      expect((yield* Effect.promise(() => readFile(log, "utf8"))).includes("session.create")).toBe(false);
      const result = yield* launch(input, ["/usr/bin/true"], reviewed, hostId);
      expect(result.sessionId).toBe("created-1");
      const calls = yield* Schema.decodeEffect(Schema.Array(Schema.fromJsonString(Schema.Array(Schema.String))))((yield* Effect.promise(() => readFile(log, "utf8"))).trim().split("\n"));
      const nativeWindow = JSON.parse(calls.find(call => call.includes("session.create"))!.at(-1)!).initial_windows[0];
      const taskCommand = nativeWindow.layout.block.options.command;
      expect(JSON.parse(taskCommand[taskCommand.indexOf("task") + 1]).session).toEqual(input.session);

      const clone: CloneInput = {
        vcs: "git", repo: join(root, "clone"), name: "Clone task", branch: "main", branchMode: "existing",
        session: { kind: "new", name: "Same label" }, source: { vcs: "git", url: bare, sourceHostId: hostId, branches: ["main"], branch: "main" }
      };
      const cloneReview = yield* planClone(clone, hostId);
      const priorCreates = calls.filter(call => call[2] === "session.create").length;
      yield* Effect.flip(launchClone({ ...clone, session: { kind: "new", name: "Changed" } }, ["/usr/bin/true"], cloneReview, hostId));
      expect((yield* Effect.promise(() => readFile(log, "utf8"))).match(/session.create/g)?.length).toBe(priorCreates);
      const cloneResult = yield* launchClone(clone, ["/usr/bin/true"], cloneReview, hostId);
      expect(cloneResult.sessionId).toBe("created-2");
      const cloneCalls = yield* Schema.decodeEffect(Schema.Array(Schema.fromJsonString(Schema.Array(Schema.String))))((yield* Effect.promise(() => readFile(log, "utf8"))).trim().split("\n"));
      const cloneWindow = JSON.parse(cloneCalls.filter(call => call.includes("session.create")).at(-1)!.at(-1)!).initial_windows[0];
      const cloneCommand = cloneWindow.layout.block.options.command;
      const cloneRequest = JSON.parse(cloneCommand[cloneCommand.indexOf("clone-task") + 1]);
      expect(cloneRequest.plan.input.session).toEqual({ kind: "new", name: "Same label" });
      expect(cloneCalls.filter(call => call[2] === "session.create")).toHaveLength(2);
      process.env.REX_SESSION = "old-id";
      process.env.REX_BLOCK = "new-block";
      const requested = { ...cloneRequest, plan: { ...cloneRequest.plan, input: { ...cloneRequest.plan.input, session: { kind: "existing", id: "created-2" } } } };
      expect((yield* Effect.flip(cloneTask(requested))).message).toContain("requested Rex session and terminal");
      process.env.REX_SESSION = "created-2";
      yield* Effect.promise(async () => {
        // Check /dev/tty at the real clone-process boundary before running each tool.
        for (const program of ["git", "jj"]) {
          const executable = Bun.which(program);
          if (!executable) throw new Error(`${program} is required for terminal integration`);
          const wrapper = join(bin, program);
          await writeFile(wrapper, `#!/bin/sh
if [ "$1" = clone ] || [ "$1 $2" = "git clone" ]; then
  exec 3<>/dev/tty || exit 1
fi
exec ${JSON.stringify(executable)} "$@"
`);
          await chmod(wrapper, 0o755);
        }
        const shellInit = join(root, "shell-init");
        await writeFile(shellInit, "if ( : <>/dev/tty ); then exit 0; else exit 1; fi\n");
        const script = `
import { BunRuntime, BunServices } from ${JSON.stringify(import.meta.resolve("@effect/platform-bun"))};
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { cloneRepository as cloneGit } from ${JSON.stringify(new URL("../src/git.ts", import.meta.url).href)};
import { cloneRepository as cloneJj } from ${JSON.stringify(new URL("../src/jj.ts", import.meta.url).href)};
import { cloneTask } from ${JSON.stringify(new URL("../src/worktrees.ts", import.meta.url).href)};
BunRuntime.runMain(Effect.gen(function*() {
  yield* cloneGit(${JSON.stringify(bare)}, ${JSON.stringify(join(root, "git-terminal"))});
  yield* cloneJj(${JSON.stringify(bare)}, ${JSON.stringify(join(root, "jj-terminal"))});
  yield* cloneTask(${JSON.stringify(cloneRequest)});
}).pipe(Effect.provide(BunServices.layer)));
`;
        let output = "";
        const decoder = new TextDecoder();
        const child = Bun.spawn([process.execPath, "-e", script], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHELL: "/bin/sh", ENV: shellInit,
            JJ_CONFIG: "", JJ_USER: "Rex Tests", JJ_EMAIL: "rex@example.test" },
          terminal: { cols: 96, rows: 24, data: (_, bytes) => { output += decoder.decode(bytes, { stream: true }); } },
        });
        // A real PTY child needs a wall-clock watchdog if it hangs; fake timers cannot stop it.
        const timeout = setTimeout(() => child.kill(), 4000);
        try {
          expect(await child.exited, output).toBe(0);
        } finally {
          clearTimeout(timeout);
          if (child.exitCode === null) child.kill();
          await child.exited;
          child.terminal?.close();
        }
        for (const destination of ["git-terminal", "jj-terminal"]) {
          expect(await readFile(join(root, destination, "tracked"), "utf8")).toBe("base\n");
        }
      });
      expect((yield* Effect.promise(() => readFile(join(root, "clone", "tracked"), "utf8")))).toBe("base\n");
      const associations = join(root, "state", "rex-worktrees", "associations");
      const entries = yield* Effect.promise(() => readdir(associations));
      expect(entries).toHaveLength(1);
      expect(JSON.parse(yield* Effect.promise(() => readFile(join(associations, entries[0]!), "utf8"))).sessionId).toBe("created-2");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(BunServices.layer))
);

it("new-session names are validated at the contract boundary", () => {
  const decode = Schema.decodeUnknownSync(SessionSelectionSchema);
  expect(decode({ kind: "new", name: "Same label" })).toEqual({ kind: "new", name: "Same label" });
  for (const name of ["", " ", "a".repeat(129), "line\nbreak", "\u007f"]) {
    expect(() => decode({ kind: "new", name })).toThrow();
  }
});
