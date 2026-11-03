import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ServerHostIdSchema, SessionSelectionSchema, type CloneInput, type LaunchInput } from "../src/contracts.ts";
import { cloneTask, launch, launchClone, planClone, planLaunch } from "../src/worktrees.ts";

it.live("reviews never create sessions; launch and clone use only the new native ID after final review", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(async () => realpath(await mkdtemp(join(tmpdir(), "rex-named-session-"))));
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const log = join(root, "rex-log.jsonl");
    const previous = Object.fromEntries(["REX_BIN_DIR", "REX_WORKTREES_LOCAL_ENDPOINT", "REX_TEST_LOG", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "HOME", "REX_SESSION", "REX_BLOCK", "SHELL"].map(key => [key, process.env[key]]));
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
const cmd = args.slice(at);
appendFileSync(process.env.REX_TEST_LOG, JSON.stringify(cmd) + "\\n");
let result;
const created = (readFileSync(process.env.REX_TEST_LOG, "utf8").match(/"session.create"/g) || []).length;
if (cmd[0] === "whoami") result = { host_id: "fixture-host", endpoint: "unix:///fixture.sock", principal: { transport: "unix" } };
else if (cmd[0] === "ls") result = { sessions: [{ session_id: "old-id", label: "Same label" },
  ...Array.from({ length: created }, (_, index) => ({ session_id: "created-" + (index + 1), label: "Same label" }))] };
else if (cmd[0] === "client" && cmd[1] === "ls") result = { clients: [] };
else if (cmd[0] === "do" && cmd[1] === "worktrees_config") result = JSON.stringify({ config: {}, directory: process.env.XDG_CONFIG_HOME + "/rex" });
else if (cmd[0] === "api" && cmd[1] === "call" && cmd[2] === "session.create") result = { session_id: "created-" + created };
else if (cmd[0] === "window" && cmd[1] === "new") result = { window_id: "new-window", block_ids: ["new-block"] };
else if (cmd[0] === "window" && cmd[1] === "ls") result = { windows: [{ window_id: "new-window", label: "Clone task", layers: [{ blocks: [{ block_id: "new-block", host_id: "fixture-host" }] }] }] };
else if (cmd[0] === "focus") result = {};
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
      expect(calls.filter(call => call[2] === "session.create")).toEqual([["api", "call", "session.create", JSON.stringify({ label: "Same label" })]]);
      const tab = calls.find(call => call[0] === "window" && call[1] === "new");
      if (!tab) throw new Error("Rex did not receive a task tab request");
      expect(tab.slice(tab.indexOf("-s"), tab.indexOf("-s") + 2)).toEqual(["-s", "created-1"]);
      expect(JSON.parse(tab[tab.indexOf("task") + 1]!).sessionId).toBe("created-1");

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
      const cloneTab = cloneCalls.filter(call => call[0] === "window" && call[1] === "new").at(-1)!;
      const cloneRequest = JSON.parse(cloneTab[cloneTab.indexOf("clone-task") + 1]!);
      expect(cloneRequest.sessionId).toBe("created-2");
      expect(cloneRequest.plan.input.session).toEqual({ kind: "new", name: "Same label" });
      expect(cloneCalls.filter(call => call[2] === "session.create")).toHaveLength(2);
      process.env.REX_SESSION = "old-id";
      process.env.REX_BLOCK = "new-block";
      expect((yield* Effect.flip(cloneTask(cloneRequest))).message).toContain("requested Rex terminal");
      process.env.REX_SESSION = "created-2";
      process.env.SHELL = "/usr/bin/true";
      yield* cloneTask(cloneRequest);
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
