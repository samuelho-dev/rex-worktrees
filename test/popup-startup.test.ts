import { expect, it } from "@effect/vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ui = pathToFileURL(resolve(root, "src/ui.ts")).href;
const client = pathToFileURL(resolve(root, "src/client.ts")).href;
const rex = pathToFileURL(resolve(root, "src/rex.ts")).href;
const effect = pathToFileURL(
  resolve(root, "node_modules/effect/dist/Effect.js"),
).href;
const runtime = pathToFileURL(
  resolve(root, "node_modules/@effect/platform-bun/dist/BunRuntime.js"),
).href;
const services = pathToFileURL(
  resolve(root, "node_modules/@effect/platform-bun/dist/BunServices.js"),
).href;

const waitFor = (
  predicate: () => boolean,
  listen: (notify: () => void) => () => void,
) => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  // Real child-process PTY integration needs a wall-clock watchdog if the child hangs.
  const timeout = setTimeout(() => {
    unsubscribe();
    reject(new Error("Timed out waiting for the popup PTY"));
  }, 5000);
  const notify = () => {
    if (!predicate()) return;
    clearTimeout(timeout);
    unsubscribe();
    resolve();
  };
  const unsubscribe = listen(notify);
  notify();
  return promise;
};

async function withPopup(
  kind: "pending" | "failure" | "edit",
  run: (pty: {
    output: () => string;
    waitForText: (text: string) => Promise<void>;
    waitForOutput: (predicate: (output: string) => boolean) => Promise<void>;
    write: (input: string) => void;
    exitCode: () => number | null;
    exited: Promise<number>;
  }) => Promise<void>,
) {
  const home = await mkdtemp(resolve(tmpdir(), "rex-worktrees-pty-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: resolve(home, "config"),
    NO_COLOR: "1",
  };
  delete env.REX_SESSION;
  delete env.REX_BLOCK;
  delete env.REX_CLIENT;
  const script = `
    import * as Effect from ${JSON.stringify(effect)};
    import * as BunRuntime from ${JSON.stringify(runtime)};
    import * as BunServices from ${JSON.stringify(services)};
    import { mock } from "bun:test";
    ${kind === "edit" ? `
      const host = { key: "local", selector: "local", label: "This machine", local: true, hostId: "host-local" };
      const project = { vcs: "git", path: "/projects/alpha", commonDir: "/git/alpha", name: "alpha" };
      const checkout = { vcs: "git", path: "/projects/alpha", branch: "main", head: "abc", bare: false, locked: false, prunable: false };
      mock.module(${JSON.stringify(client)}, () => ({
        listMachines: Effect.succeed([host]),
        connectMachine: () => Effect.succeed(host),
        discover: () => Effect.succeed({ projects: [project], checkout: project,
          sessions: [{ id: "session-local", label: "Session" }], clients: [],
          roots: ["/projects"], cloneRoot: "/projects" }),
        inspectProject: () => Effect.succeed({ project, checkout: project, worktrees: [checkout], branches: ["main"], revisions: [] }),
        inspectWorktrees: () => Effect.succeed({ worktrees: [checkout], branches: ["main"], revisions: [] }),
        inspectRevision: () => Effect.die("Unexpected revision helper"),
        sourceForClone: () => Effect.die("Unexpected clone source helper"),
        reviewClone: () => Effect.die("Unexpected clone review helper"),
        submitClone: () => Effect.die("Unexpected clone launch helper"),
        review: (_, __, input) => Effect.sync(() => { process.stderr.write("REVIEW_CALLED\\n");
          return { vcs: "git", input, hostId: host.hostId, sessionId: input.sessionId,
            path: project.path, action: "new-tab", checkout: "existing", branch: "main",
            nameRole: "tab", name: input.name, label: "Open reviewed checkout", detail: "Destination: /projects/alpha" }; }),
        submit: () => Effect.sync(() => { process.stderr.write("LAUNCH_CALLED\\n");
          return { sessionId: "session-local", path: project.path, action: "new-tab", pending: false }; })
      }));
      const originalRex = await import(${JSON.stringify(rex)});
      mock.module(${JSON.stringify(rex)}, () => ({ ...originalRex, makePopupSizer: Effect.succeed(() => Effect.succeed(undefined)) }));
    ` : ""}
    // Load after module mocks so this PTY drives the real popup against recorded client calls.
    const { popup } = await import(${JSON.stringify(ui)});
    const context = ${kind === "pending"
      ? 'Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => process.stderr.write("DISCOVERY_INTERRUPTED"))))'
      : kind === "edit" ? 'Effect.succeed("/projects/alpha")'
        : 'Effect.fail(new Error("synthetic startup failure"))'
    };
    BunRuntime.runMain(Effect.provide(popup([], context), BunServices.layer));
  `;
  let output = "";
  const listeners = new Set<() => void>();
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: root,
    env,
    terminal: {
      cols: 96,
      rows: 24,
      data: (_, bytes) => {
        output += new TextDecoder().decode(bytes);
        for (const listener of listeners) listener();
      },
    },
  });
  try {
    await run({
      output: () => output,
      waitForText: (text) =>
        waitFor(
          () => output.includes(text),
          (notify) => {
            listeners.add(notify);
            return () => {
              listeners.delete(notify);
            };
          },
        ),
      waitForOutput: (predicate) => waitFor(
        () => predicate(output),
        (notify) => {
          listeners.add(notify);
          return () => { listeners.delete(notify); };
        },
      ),
      write: (input) => proc.terminal!.write(input),
      exitCode: () => proc.exitCode,
      exited: proc.exited,
    });
  } catch (error) {
    throw new Error(`Popup PTY failed; captured output:\n${output}`, { cause: error });
  } finally {
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
    proc.terminal?.close();
    await rm(home, { recursive: true, force: true });
  }
}

for (const [name, input] of [
  ["Esc", "\x1b"],
  ["Cancel", "\x1b[Z\r"],
]) {
  it(`initial form ${name} interrupts discovery without starting a task`, async () => {
    await withPopup("pending", async (pty) => {
      await pty.waitForText("MODE");
      expect(pty.exitCode()).toBeNull();
      pty.write(input);
      expect(await pty.exited).toBe(0);
      expect(pty.output()).toContain("DISCOVERY_INTERRUPTED");
    });
  }, 8000);
}

it("initial form submit stays disabled while discovery runs and Esc still cancels", async () => {
  await withPopup("pending", async (pty) => {
    await pty.waitForText("MODE");
    pty.write("\t\t\t\t\t\t\r"); // Project through six fields to submit; Enter cannot launch.
    expect(pty.exitCode()).toBeNull();
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);
    expect(pty.output()).toContain("DISCOVERY_INTERRUPTED");
  });
}, 8000);

it("fatal startup error remains visible until acknowledgement and exits nonzero", async () => {
  await withPopup("failure", async (pty) => {
    await pty.waitForText("Could not open worktrees");
    await pty.waitForText("synthetic startup failure");
    expect(pty.exitCode()).toBeNull();
    pty.write("\r");
    expect(await pty.exited).not.toBe(0);
  });
}, 8000);

for (const [key, accept] of [["Enter", "\r"], ["Ctrl+S", "\x13"]] as const) {
  it(`editor ${key} accepts a field without reviewing or launching; form submission reviews then launches once`, async () => {
    await withPopup("edit", async (pty) => {
      await pty.waitForText("Existing checkout");
      pty.write("\t\t\t\t\t\r"); // Select Mode from the form.
      await pty.waitForText("Open mode");
      pty.write(`\x1b[B${accept}`); // Choose Always new tab and accept from the editor.
      await pty.waitForOutput(output => /MODE\s+Always new tab/.test(output));
      expect(pty.exitCode()).toBeNull();
      expect(pty.output()).not.toContain("REVIEW_CALLED");
      expect(pty.output()).not.toContain("LAUNCH_CALLED");
      pty.write("\x13"); // Explicit form submission produces a review, not a launch.
      await pty.waitForText("Review this action");
      expect(pty.output().match(/REVIEW_CALLED/g)).toHaveLength(1);
      expect(pty.output()).not.toContain("LAUNCH_CALLED");
      pty.write("\x13"); // Second explicit submission confirms the reviewed action.
      expect(await pty.exited).toBe(0);
      expect(pty.output().match(/REVIEW_CALLED/g)).toHaveLength(2);
      expect(pty.output().match(/LAUNCH_CALLED/g)).toHaveLength(1);
    });
  }, 8000);
}
