import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { BlockIdSchema, SessionIdSchema } from "../src/contracts.ts";
import { originDirectory } from "../src/rex.ts";

const fixture = vi.hoisted(() => ({
  pwd: "file://foreign.invalid/projects/current",
  blockHost: "local-host",
  identityHost: "local-host",
  calls: [] as string[],
}));

vi.mock("../src/process.ts", async () => {
  // The mock must load Effect after Vitest installs this hoisted module boundary.
  const { Effect } = await import("effect");
  return {
    run: (_program: string, args: readonly string[]) => Effect.sync(() => {
      const command = args.at(-1)!;
      fixture.calls.push(command);
      if (args.includes("whoami")) return JSON.stringify({ host_id: fixture.identityHost, endpoint: "unix:///tmp/rex.sock", principal: { transport: "unix" } });
      if (args.includes("window")) return JSON.stringify({ windows: [{ window_id: "window", label: "window", layers: [{ blocks: [{ block_id: "block", host_id: fixture.blockHost }] }] }] });
      if (command === "pwd") return JSON.stringify({ pwd: fixture.pwd });
      if (command === "process") return JSON.stringify({ last_exit: null, foreground: { cwd: "/projects/current" } });
      throw new Error(`Unexpected Rex call: ${args.join(" ")}`);
    })
  };
});

it("selects a verified pane's foreground directory when its reported URI is not local", async () => {
  const session = SessionIdSchema.make("session");
  const block = BlockIdSchema.make("block");
  const origin = () => Effect.runPromise(Effect.provide(originDirectory(session, block), BunServices.layer));

  expect(await origin()).toBe("/projects/current");
  expect(fixture.calls).toContain("process");

  fixture.calls = [];
  fixture.pwd = "file://localhost/projects/reported";
  fixture.identityHost = "replacement-local-host";
  fixture.blockHost = "replacement-local-host";
  expect(await origin()).toBe("/projects/reported");
  expect(fixture.calls).not.toContain("process");

  fixture.calls = [];
  fixture.blockHost = "remote-host";
  expect(await origin()).toBeUndefined();
  expect(fixture.calls).not.toContain("pwd");
  expect(fixture.calls).not.toContain("process");
});
