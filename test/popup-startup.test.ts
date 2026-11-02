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
  kind: "pending" | "failure" | "edit" | "session" | "collision" | "permission" | "unsafe" | "connect" | "changed" | "jj" | "detached" | "long",
  run: (pty: {
    output: () => string;
    waitForText: (text: string | RegExp, from?: number) => Promise<void>;
    waitForForm: (text: string | RegExp, from?: number) => Promise<string>;
    waitForEditor: (text: string | RegExp, from?: number) => Promise<string>;
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
    ${kind !== "pending" && kind !== "failure" ? `
      const scenario = ${JSON.stringify(kind)};
      const { AppError } = await import(${JSON.stringify(pathToFileURL(resolve(root, "src/contracts.ts")).href)});
      const host = { key: "local", selector: "local", label: "This machine", local: true, hostId: "host-local" };
      const remote = { key: "remote", selector: "remote", label: "Remote machine", local: false, hostId: "host-remote" };
      const name = scenario === "unsafe" ? "alpha\\\\name" : "alpha";
      const project = scenario === "jj"
        ? { vcs: "jj", path: "/projects/alpha", commonDir: "/projects/alpha/.jj/repo", name }
        : { vcs: "git", path: scenario === "long" ? "/projects/" + "nested/".repeat(35) + "alpha" : "/projects/" + name, commonDir: "/git/alpha", name };
      const checkout = scenario === "jj"
        ? { vcs: "jj", path: project.path, name, head: "a".repeat(40), changeId: "k".repeat(32), present: true, colocated: false }
        : { vcs: "git", path: project.path, branch: "main", head: "abc", bare: false, locked: false, prunable: false };
      const revisions = scenario === "jj" ? [
        { expression: "trunk()", label: "trunk()", revision: { commitId: "a".repeat(40), changeId: "k".repeat(32), description: "mainline" } },
        { expression: "candidate", label: "candidate", revision: { commitId: "b".repeat(40), changeId: "m".repeat(32), description: "alternate" } }
      ] : [];
      let reviewCount = 0;
      mock.module(${JSON.stringify(client)}, () => ({
        listMachines: Effect.succeed(scenario === "edit" || scenario === "unsafe" ? [host] : [host, remote]),
        connectMachine: machine => scenario === "connect" && machine.key === "remote"
          ? Effect.fail(new AppError({ message: "Remote helper unavailable; install and reload Rex" }))
          : Effect.succeed(machine),
        discover: machine => Effect.succeed({ projects: machine.local ? [project] : [], checkout: machine.local ? project : undefined,
          sessions: scenario === "session" ? [{ id: "session-first", label: "Same label" }, { id: "session-second", label: "Same label" }]
            : [{ id: "session-local", label: "Session" }], clients: [],
          roots: ["/clones"], cloneRoot: "/clones" }),
        inspectProject: (_, __, path) => path === project.path
          ? Effect.succeed({ project, checkout: project, worktrees: [checkout], branches: ["main", "feature/free"], revisions })
          : Effect.fail(new AppError({ message: "Not a repository: " + path })),
        inspectWorktrees: () => Effect.succeed({ worktrees: [checkout], branches: ["main", "feature/free"], revisions }),
        inspectRevision: () => Effect.die("Unexpected revision helper"),
        sourceForClone: () => Effect.succeed({ vcs: "git", url: "https://example.test/alpha.git",
          sourceHostId: host.hostId, branches: ["main"], ...(scenario === "detached" ? {} : { branch: "main" }) }),
        reviewClone: (_, __, input) => {
          process.stderr.write("REVIEW_CLONE " + input.repo + "\\n");
          process.stderr.write("CLONE_INPUT " + JSON.stringify(input) + "\\n");
          return input.repo === "/clones/alpha"
            ? Effect.fail(new AppError({ message: scenario === "permission"
              ? "Cannot write clone destination parent: " + input.repo
              : "Clone destination already exists and is not a repository: " + input.repo }))
            : Effect.succeed({ vcs: "git", input, hostId: remote.hostId,
              repo: input.repo, existing: false, label: "Clone & Open", detail: "Destination: " + input.repo });
        },
        submitClone: () => Effect.sync(() => { process.stderr.write("CLONE_LAUNCHED\\n"); return { sessionId: "session-local", repo: "/safe/alpha" }; }),
        review: (_, __, input) => Effect.sync(() => {
          process.stderr.write("REVIEW_CALLED " + JSON.stringify(input) + "\\n");
          const path = scenario === "changed" && ++reviewCount > 1 ? "/projects/alpha.changed" : project.path;
          return { vcs: input.vcs, input, hostId: host.hostId,
            path, action: "new-tab", checkout: input.path ? "existing" : "create",
            ...(input.vcs === "git" ? { branch: input.branch ?? "main" } : {}),
            nameRole: "tab", name: input.name,
            label: input.path ? "Open reviewed checkout" : "Create checkout & open" };
        }),
        submit: (_, __, input, plan) => Effect.sync(() => { process.stderr.write("LAUNCH_CALLED " + JSON.stringify(input.session) + " " + plan.path + "\\n");
          return { sessionId: input.session.kind === "new" ? "created-id" : input.session.id, path: plan.path, action: "new-tab", pending: false }; })
      }));
      const originalRex = await import(${JSON.stringify(rex)});
      mock.module(${JSON.stringify(rex)}, () => ({ ...originalRex, makePopupSizer: Effect.succeed(() => Effect.succeed(undefined)) }));
    ` : ""}
    // Load after module mocks so this PTY drives the real popup against recorded client calls.
    const { popup } = await import(${JSON.stringify(ui)});
    const context = ${kind === "pending"
      ? 'Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => process.stderr.write("DISCOVERY_INTERRUPTED"))))'
      : kind === "failure" ? 'Effect.fail(new Error("synthetic startup failure"))'
        : kind === "unsafe" ? 'Effect.succeed("/projects/alpha\\\\name")'
          : kind === "long" ? 'Effect.succeed("/projects/" + "nested/".repeat(35) + "alpha")'
            : 'Effect.succeed("/projects/alpha")'
    };
    BunRuntime.runMain(Effect.provide(popup([], context), BunServices.layer));
  `;
  let output = "";
  const listeners = new Set<() => void>();
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: root,
    env,
    terminal: {
      cols: kind === "long" ? 60 : 96,
      rows: kind === "long" ? 18 : kind === "edit" ? 16 : 24,
      data: (_, bytes) => {
        output += new TextDecoder().decode(bytes);
        for (const listener of listeners) listener();
      },
    },
  });
  let awaiting = "";
  const listen = (notify: () => void) => {
    listeners.add(notify);
    return () => { listeners.delete(notify); };
  };
  const currentForm = (text: string | RegExp, from: number) => {
    const start = output.lastIndexOf("\x1b[H\x1b[2J");
    if (start < from) return undefined;
    const frame = output.slice(start);
    return frame.includes("└") && frame.includes("Tab next") &&
      (typeof text === "string" ? frame.includes(text) : text.test(frame)) ? frame : undefined;
  };
  const currentEditor = (text: string | RegExp, from: number) => {
    const start = output.lastIndexOf("\x1b[H\x1b[2J");
    if (start < from) return undefined;
    const frame = output.slice(start);
    return frame.includes("Esc back") &&
      (typeof text === "string" ? frame.includes(text) : text.test(frame)) ? frame : undefined;
  };
  try {
    await run({
      output: () => output,
      waitForText: (text, from = 0) => {
        awaiting = `text ${String(text)} after ${from}`;
        return waitFor(() => typeof text === "string" ? output.slice(from).includes(text) : text.test(output.slice(from)), listen);
      },
      waitForForm: async (text, from = 0) => {
        awaiting = `complete form ${String(text)} after ${from}`;
        await waitFor(() => !!currentForm(text, from), listen);
        return currentForm(text, from)!;
      },
      waitForEditor: async (text, from = 0) => {
        awaiting = `complete editor ${String(text)} after ${from}`;
        await waitFor(() => !!currentEditor(text, from), listen);
        return currentEditor(text, from)!;
      },
      write: (input) => proc.terminal!.write(input),
      exitCode: () => proc.exitCode,
      exited: proc.exited,
    });
  } catch (error) {
    const lastFrame = output.slice(output.lastIndexOf("\x1b[H\x1b[2J"));
    throw new Error(`Popup PTY failed (${kind}) waiting for ${awaiting}: ${String(error)}\nLatest frame:\n${lastFrame.slice(0, 450)}\n…\n${lastFrame.slice(-650)}`, { cause: error });
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
    pty.write("\x13");
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
  it(`project editor ${key} accepts an exact inspected checkout without reviewing or launching`, async () => {
    await withPopup("edit", async (pty) => {
      await pty.waitForText(/CHECKOUT\s+alpha/);
      await pty.waitForText("Esc close");
      pty.write("\r");
      await pty.waitForText("Project (select known");
      const before = pty.output().length;
      pty.write(`\x1b[B${accept}`);
      await pty.waitForText(/CHECKOUT\s+alpha/, before);
      expect(pty.exitCode()).toBeNull();
      expect(pty.output()).not.toContain("REVIEW_CALLED");
      expect(pty.output()).not.toContain("LAUNCH_CALLED");
      pty.write("\x13");
      expect(await pty.exited).toBe(0);
      expect(pty.output().match(/REVIEW_CALLED/g)).toHaveLength(1);
      expect(pty.output()).toContain('"path":"/projects/alpha"');
      expect(pty.output().match(/LAUNCH_CALLED/g)).toHaveLength(1);
    });
  }, 8000);
}

for (const [name, input, frame, selection, needsReview] of [
  ["typed session matching an existing label stays new", "Same label\r", "New: Same label", { kind: "new", name: "Same label" }, true],
  ["duplicate labels select the exact second session ID", "\x1b[B\x1b[B\r", /SESSION\s+Same label/, { kind: "existing", id: "session-second" }, false]
] as const) {
  it(name, async () => {
    await withPopup("session", async (pty) => {
      await pty.waitForText(/CHECKOUT\s+alpha/);
      await pty.waitForText("Esc close");
      pty.write("\t\t\t\r");
      await pty.waitForText("Session (select existing or type new name)");
      pty.write(input);
      await pty.waitForText(frame);
      expect(pty.output()).not.toContain("REVIEW_CALLED");
      expect(pty.output()).not.toContain("LAUNCH_CALLED");
      pty.write("\x13");
      if (needsReview) {
        await pty.waitForText("Review this action");
        expect(pty.output()).not.toContain("LAUNCH_CALLED");
        pty.write("\x13");
      }
      expect(await pty.exited).toBe(0);
      expect(pty.output()).toContain(`LAUNCH_CALLED ${JSON.stringify(selection)}`);
    });
  }, 8000);
}

it("flat ordinary form edits Mode directly without launching from its editor", async () => {
  await withPopup("edit", async (pty) => {
    await pty.waitForText(/CHECKOUT\s+alpha/);
    await pty.waitForText("Esc close");
    expect(pty.output()).toContain("MODE");
    expect(pty.output()).not.toContain("OPTIONS");
    pty.write("\t\t\t\t\r");
    await pty.waitForText("Open mode");
    pty.write("Always new tab\x1b[B\r");
    await pty.waitForText(/MODE\s+Always new tab/);
    expect(pty.output()).not.toContain("REVIEW_CALLED");
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);
  });
}, 8000);

it("typing an occupied Git branch opens its exact existing checkout", async () => {
  await withPopup("edit", async (pty) => {
    await pty.waitForText(/CHECKOUT\s+alpha/);
    await pty.waitForText("Esc close");
    pty.write("\t\t\r");
    await pty.waitForText("Checkout (");
    const before = pty.output().length;
    pty.write("main\r");
    await pty.waitForText(/CHECKOUT\s+alpha/, before);
    expect(pty.output()).not.toContain("REVIEW_CALLED");
    pty.write("\x13");
    expect(await pty.exited).toBe(0);
    expect(pty.output()).toContain('"path":"/projects/alpha"');
    expect(pty.output()).not.toContain('"branch":"main","worktreeName"');
  });
}, 8000);

it("typed Git branch shows an independent directory row and requires review", async () => {
  await withPopup("edit", async (pty) => {
    await pty.waitForText(/CHECKOUT\s+alpha/);
    await pty.waitForText("Esc close");
    expect(pty.output()).toContain("MODE");
    expect(pty.output()).not.toContain("OPTIONS");
    expect(pty.output()).not.toContain("  DIRECTORY  ");
    pty.write("\t\t\r");
    await pty.waitForText("Checkout (");
    const beforeBranch = pty.output().length;
    pty.write("feature/free\r");
    await pty.waitForText("Esc close", beforeBranch);
    const branchFrame = pty.output().slice(pty.output().lastIndexOf("\x1b[H\x1b[2J"));
    expect(branchFrame).toMatch(/CHECKOUT\s+feature\/free/);
    expect(branchFrame).toMatch(/DIRECTORY\s+Default/);
    expect(branchFrame).toContain("MODE");
    expect(branchFrame).not.toContain("OPTIONS");
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
    pty.write("\t\t\r");
    await pty.waitForText("Optional custom checkout directory name");
    pty.write("custom-tree\r");
    await pty.waitForText(/DIRECTORY\s+custom-tree/);
    expect(pty.output()).not.toContain("REVIEW_CALLED");
    pty.write("\x13");
    await pty.waitForText("Review this action");
    expect(pty.output()).toContain('"branch":"feature/free"');
    expect(pty.output()).toContain('"worktreeName":"custom-tree"');
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
    pty.write("\x13");
    expect(await pty.exited).toBe(0);
    expect(pty.output().match(/LAUNCH_CALLED/g)).toHaveLength(1);
  });
}, 8000);

it("a changed reviewed target is displayed and needs another explicit confirmation", async () => {
  await withPopup("changed", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\t\t\r");
    await pty.waitForText("Checkout (");
    const beforeBranch = pty.output().length;
    pty.write("feature/free\r");
    await pty.waitForForm(/CHECKOUT\s+feature\/free/, beforeBranch);
    const beforeReview = pty.output().length;
    pty.write("\x13");
    await pty.waitForForm("Review this action", beforeReview);
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
    const beforeChange = pty.output().length;
    pty.write("\x13");
    const displayed = await pty.waitForForm("Destination or Rex target changed", beforeChange);
    expect(displayed).toContain("Destination or Rex target changed");
    expect(displayed).toContain("Destination: /projects/alpha.changed");
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
    pty.write("\x13");
    expect(await pty.exited).toBe(0);
    expect(pty.output()).toContain("LAUNCH_CALLED");
  });
}, 8000);

it("a new JJ workspace retains its name when the starting revision changes", async () => {
  await withPopup("jj", async (pty) => {
    await pty.waitForForm(/WORKSPACE\s+alpha/);
    pty.write("\t\t\r");
    await pty.waitForText("Workspace (select existing");
    const beforeName = pty.output().length;
    pty.write("task-space\r");
    const namedFrame = await pty.waitForForm(/WORKSPACE\s+task-space/, beforeName);
    expect(namedFrame).toContain("START FROM");
    pty.write("\t\t\r");
    await pty.waitForText("Start from revision for new workspace");
    const beforeRevision = pty.output().length;
    pty.write("candidate\x1b[B\r");
    const currentFrame = await pty.waitForForm(/START FROM\s+candidate/, beforeRevision);
    expect(currentFrame).toMatch(/WORKSPACE\s+task-space/);
    pty.write("\x13");
    await pty.waitForText("REVIEW_CALLED");
    expect(pty.output()).toContain('"worktreeName":"task-space"');
    expect(pty.output()).toContain('"revision":"' + "b".repeat(40) + '"');
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);
  });
}, 8000);

it("a detached clone exposes required Branch in the flat form", async () => {
  await withPopup("detached", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\t\r");
    await pty.waitForText("Execution machine");
    pty.write("\x1b[B\r");
    const cloneFrame = await pty.waitForForm(/CLONE TO\s+\/clones\/alpha/);
    expect(cloneFrame).toMatch(/BRANCH\s+Select or type branch/);
    expect(cloneFrame).toMatch(/DIRECTORY\s+Default/);
    expect(cloneFrame).not.toContain("MODE");
    expect(cloneFrame).not.toContain("OPTIONS");
    pty.write("\t\r");
    await pty.waitForText("Clone to (absolute destination");
    const beforeDestination = pty.output().length;
    pty.write("/safe/alpha\r");
    await pty.waitForForm(/CLONE TO\s+\/safe\/alpha/, beforeDestination);
    pty.write("\t\t\r");
    await pty.waitForText("Branch (select source branch");
    const beforeBranch = pty.output().length;
    pty.write("\x1b[B\r");
    await pty.waitForForm(/BRANCH\s+main/, beforeBranch);
    pty.write("\x13");
    await pty.waitForText("CLONE_INPUT");
    expect(pty.output()).toContain('"branch":"main"');
    expect(pty.output()).not.toContain("CLONE_LAUNCHED");
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);
  });
}, 8000);

it("a clamped long checkout path needs review before opening", async () => {
  await withPopup("long", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\x13");
    await pty.waitForText("REVIEW_CALLED");
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);
  });
}, 8000);

it("clone path editor cannot launch; optional checkout name remains independent", async () => {
  await withPopup("collision", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\t\r");
    await pty.waitForText("Execution machine");
    pty.write("\x1b[B\r");
    await pty.waitForForm(/CLONE TO\s+\/clones\/alpha/);
    pty.write("\t\r");
    await pty.waitForText("Clone to (absolute destination");
    const beforeDestination = pty.output().length;
    pty.write("/safe/alpha\r");
    await pty.waitForForm(/CLONE TO\s+\/safe\/alpha/, beforeDestination);
    expect(pty.output()).not.toContain("REVIEW_CLONE");
    expect(pty.output()).not.toContain("CLONE_LAUNCHED");
    pty.write("\t\t\t\r");
    await pty.waitForEditor("Optional custom checkout directory name");
    const beforeName = pty.output().length;
    pty.write("separate-checkout\r");
    await pty.waitForForm(/DIRECTORY\s+separate-checkout/, beforeName);
    const beforeReopen = pty.output().length;
    pty.write("\r");
    await pty.waitForEditor("Optional custom checkout directory name", beforeReopen);
    const beforeClear = pty.output().length;
    pty.write("\x1b[B\r"); // Select the explicit Use default choice.
    await pty.waitForForm(/DIRECTORY\s+Default/, beforeClear);
    const beforeAnotherReopen = pty.output().length;
    pty.write("\r");
    await pty.waitForEditor("Optional custom checkout directory name", beforeAnotherReopen);
    const beforeNewName = pty.output().length;
    pty.write("separate-checkout\r");
    await pty.waitForForm(/DIRECTORY\s+separate-checkout/, beforeNewName);
    expect(pty.output()).toContain("/safe/alpha");
    pty.write("\x13");
    await pty.waitForText("CLONE_INPUT");
    expect(pty.output()).toContain('"repo":"/safe/alpha"');
    expect(pty.output()).toContain('"worktreeName":"separate-checkout"');
    expect(pty.output()).not.toContain("CLONE_LAUNCHED");
    pty.write("\x13");
    expect(await pty.exited).toBe(0);
    expect(pty.output()).toContain("CLONE_LAUNCHED");
  });
}, 8000);

for (const [kind, diagnostic] of [
  ["collision", "Clone destination already exists and is not a repository"],
  ["permission", "Cannot write clone destination parent"]
] as const) {
  it(`clone destination remains a literal editable path after ${kind} review failure`, async () => {
    await withPopup(kind, async (pty) => {
      await pty.waitForForm(/CHECKOUT\s+alpha/);
      pty.write("\t\r");
      await pty.waitForText("Execution machine");
      pty.write("\x1b[B\r");
      await pty.waitForForm(/CLONE TO\s+\/clones\/alpha/);
      expect(pty.output()).not.toContain("CLONE_LAUNCHED");
      pty.write("\x13");
      await pty.waitForText(diagnostic);
      expect(pty.output()).not.toContain("CLONE_LAUNCHED");
      pty.write("\x1b[Z\x1b[Z\x1b[Z\x1b[Z\r");
      await pty.waitForText("Clone to (absolute destination");
      const beforeDestination = pty.output().length;
      pty.write("/safe/alpha\r");
      await pty.waitForForm(/CLONE TO\s+\/safe\/alpha/, beforeDestination);
      expect(pty.output()).not.toContain("CLONE_LAUNCHED");
      pty.write("\x13");
      await pty.waitForText("REVIEW_CLONE /safe/alpha");
      expect(pty.output()).not.toContain("CLONE_LAUNCHED");
      pty.write("\x1b");
      expect(await pty.exited).toBe(0);
    });
  }, 8000);
}

it("existing checkout with backslash basename can open clone chooser and accept an absolute override", async () => {
  await withPopup("unsafe", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\t\t\r");
    await pty.waitForEditor("Checkout (select exact worktree");
    expect(pty.output()).not.toContain("Could not open worktrees");
    const beforeFilter = pty.output().length;
    pty.write("Clone this project");
    await pty.waitForEditor("Clone this project…", beforeFilter);
    pty.write("\x1b[B\r");
    await pty.waitForEditor("Project name is not a safe clone directory");
    const beforeDestination = pty.output().length;
    pty.write("/safe/alpha\r");
    await pty.waitForForm(/CLONE TO\s+\/safe\/alpha/, beforeDestination);
    expect(pty.output()).not.toContain("CLONE_LAUNCHED");
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);
  });
}, 8000);

it("machine field acceptance preserves the new connection error", async () => {
  await withPopup("connect", async (pty) => {
    await pty.waitForText(/CHECKOUT\s+alpha/);
    await pty.waitForText("Esc close");
    pty.write("\t\r");
    await pty.waitForText("Execution machine");
    pty.write("\x1b[B\r");
    await pty.waitForText("Remote helper unavailable; install and reload Rex");
    expect(pty.output()).not.toContain("REVIEW_CALLED");
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);
  });
}, 8000);
