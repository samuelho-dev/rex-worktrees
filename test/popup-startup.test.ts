import { expect, it } from "@effect/vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ui = pathToFileURL(resolve(root, "src/ui.ts")).href;
const client = pathToFileURL(resolve(root, "src/client.ts")).href;
const effect = pathToFileURL(
  resolve(root, "node_modules/effect/dist/Effect.js"),
).href;
const runtime = pathToFileURL(
  resolve(root, "node_modules/@effect/platform-bun/dist/BunRuntime.js"),
).href;
const services = pathToFileURL(
  resolve(root, "node_modules/@effect/platform-bun/dist/BunServices.js"),
).href;

const waitFor = <T>(
  predicate: () => T | undefined,
  listen: (notify: () => void) => () => void,
) => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  // Real child-process PTY integration needs a wall-clock watchdog if the child hangs.
  const timeout = setTimeout(() => {
    unsubscribe();
    reject(new Error("Timed out waiting for the popup PTY"));
  }, 5000);
  const notify = () => {
    const match = predicate();
    if (match === undefined || match === false) return;
    clearTimeout(timeout);
    unsubscribe();
    resolve(match);
  };
  const unsubscribe = listen(notify);
  notify();
  return promise;
};

const currentForm = (output: string, text: string | RegExp, from: number) => {
  const start = output.lastIndexOf("\x1b[H\x1b[2J");
  if (start < from) return undefined;
  const frame = output.slice(start);
  return /\n└─*┘/.test(frame) && frame.includes("Tab next") &&
    (typeof text === "string" ? frame.includes(text) : text.test(frame)) ? frame : undefined;
};

async function withPopup(
  kind: "pending" | "failure" | "edit" | "session" | "collision" | "permission" | "unsafe" | "connect" | "switch-pending" | "redirect" | "warning" | "clone-warning" | "clone-changed" | "clone-failure" | "jj" | "detached" | "long",
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
    import { run } from ${JSON.stringify(pathToFileURL(resolve(root, "src/process.ts")).href)};
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
      const connect = machine => scenario === "connect" && machine.key === "remote"
        ? Effect.fail(new AppError({ message: "Remote helper unavailable; install and reload Rex" }))
        : Effect.succeed(machine);
      const discover = machine => Effect.succeed({ projects: machine.local ? [project] : [], checkout: machine.local ? project : undefined,
        sessions: scenario === "session" ? [{ id: "session-first", label: "Same label" }, { id: "session-second", label: "Same label" }]
          : [{ id: "session-local", label: "Session" }], clients: [],
        roots: ["/clones"], cloneRoot: "/clones" });
      mock.module(${JSON.stringify(client)}, () => ({
        listMachines: Effect.succeed(scenario === "edit" || scenario === "unsafe" ? [host] : [host, remote]),
        connectMachine: connect,
        inspectSessions: machine => discover(machine),
        connectAndDiscover: machine => Effect.gen(function*() {
          if (scenario === "switch-pending" && !machine.local) yield* Effect.never;
          const connected = yield* connect(machine);
          return { host: connected, ...(yield* discover(connected)) };
        }),
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
              repo: scenario === "clone-changed" ? "/safe/alpha.changed" : input.repo,
              existing: false, label: "Clone & Open", detail: "Destination: " + input.repo,
              ...(scenario === "clone-warning" || scenario === "clone-changed" ? { warning: "Multiple Rex apps are connected" } : {}) });
        },
        submitClone: (_, __, input, plan) => scenario === "clone-failure"
          ? run(process.execPath, ["-e", 'console.error("Destination request rejected"); process.exit(4)', "request-body-".repeat(2000)])
          : Effect.sync(() => { process.stderr.write("CLONE_LAUNCHED " + JSON.stringify(input.session) + " " + plan.repo + "\\n"); return { sessionId: "session-local", repo: plan.repo }; }),
        review: (_, __, input) => Effect.sync(() => {
          process.stderr.write("REVIEW_CALLED " + JSON.stringify(input) + "\\n");
          const path = scenario === "redirect" ? "/projects/other" : project.path;
          return { vcs: input.vcs, input, hostId: host.hostId,
            path, action: "new-tab", checkout: input.path ? "existing" : "create",
            ...(input.vcs === "git" ? { branch: input.branch ?? "main" } : {}),
            nameRole: "tab", name: input.name,
            label: input.path ? "Open tab" : input.vcs === "jj" ? "Create workspace & open" : "Create worktree & open",
            ...(scenario === "warning" ? { warning: "Multiple Rex apps are connected" } : {}) };
        }),
        submit: (_, __, input, plan) => Effect.sync(() => { process.stderr.write("LAUNCH_CALLED " + JSON.stringify(input.session) + " " + plan.path + "\\n");
          return { sessionId: input.session.kind === "new" ? "created-id" : input.session.id, path: plan.path, action: "new-tab", pending: false }; })
      }));
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
  const decoder = new TextDecoder();
  const listeners = new Set<() => void>();
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: root,
    env,
    terminal: {
      cols: kind === "long" ? 60 : 96,
      rows: kind === "long" ? 18 : kind === "edit" || kind === "connect" ? 16 : 24,
      data: (_, bytes) => {
        output += decoder.decode(bytes, { stream: true });
        for (const listener of listeners) listener();
      },
    },
  });
  let awaiting = "";
  const listen = (notify: () => void) => {
    listeners.add(notify);
    return () => { listeners.delete(notify); };
  };
  const currentEditor = (text: string | RegExp, from: number) => {
    const start = output.lastIndexOf("\x1b[H\x1b[2J");
    if (start < from) return undefined;
    const frame = output.slice(start);
    return /\n└─*┘/.test(frame) && frame.includes("Esc back") &&
      (typeof text === "string" ? frame.includes(text) : text.test(frame)) ? frame : undefined;
  };
  try {
    await run({
      output: () => output,
      waitForText: (text, from = 0) => {
        awaiting = `text ${String(text)} after ${from}`;
        return waitFor(() => typeof text === "string" ? output.slice(from).includes(text) : text.test(output.slice(from)), listen).then(() => { });
      },
      waitForForm: (text, from = 0) => {
        awaiting = `complete form ${String(text)} after ${from}`;
        return waitFor(() => currentForm(output, text, from), listen);
      },
      waitForEditor: (text, from = 0) => {
        awaiting = `complete editor ${String(text)} after ${from}`;
        return waitFor(() => currentEditor(text, from), listen);
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
      await pty.waitForForm(/CHECKOUT\s+alpha/);
      pty.write("\r");
      await pty.waitForEditor("Project (select known");
      const beforeSelection = pty.output().length;
      pty.write("\x1b[B");
      const editor = await pty.waitForEditor(/› alpha/, beforeSelection);
      expect(editor).toMatch(/CHECKOUT\s+alpha/);
      expect(editor).not.toContain("Tab next");
      const beforeAccept = pty.output().length;
      pty.write(accept);
      await pty.waitForForm(/CHECKOUT\s+alpha/, beforeAccept);
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

for (const [name, input, frame, selection] of [
  ["typed session matching an existing label stays new", "Same label\r", "New: Same label", { kind: "new", name: "Same label" }],
  ["duplicate labels select the exact second session ID", "\x1b[B\x1b[B\r", /SESSION\s+Same label/, { kind: "existing", id: "session-second" }]
] as const) {
  it(name, async () => {
    await withPopup("session", async (pty) => {
      await pty.waitForForm(/CHECKOUT\s+alpha/);
      pty.write("\t\t\t\r");
      await pty.waitForText("Session (select existing or type new name)");
      pty.write(input);
      await pty.waitForText(frame);
      expect(pty.output()).not.toContain("REVIEW_CALLED");
      expect(pty.output()).not.toContain("LAUNCH_CALLED");
      pty.write("\x13");
      expect(await pty.exited).toBe(0);
      expect(pty.output().match(/REVIEW_CALLED/g)).toHaveLength(1);
      expect(pty.output().match(/LAUNCH_CALLED/g)).toHaveLength(1);
      expect(pty.output()).toContain(`LAUNCH_CALLED ${JSON.stringify(selection)}`);
    });
  }, 8000);
}

it("flat ordinary form edits Mode directly without launching from its editor", async () => {
  await withPopup("edit", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
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
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\t\t\r");
    await pty.waitForEditor("Checkout (");
    const before = pty.output().length;
    pty.write("main\r");
    await pty.waitForForm(/CHECKOUT\s+alpha/, before);
    expect(pty.output()).not.toContain("REVIEW_CALLED");
    pty.write("\x13");
    expect(await pty.exited).toBe(0);
    expect(pty.output()).toContain('"path":"/projects/alpha"');
    expect(pty.output()).not.toContain('"branch":"main","worktreeName"');
  });
}, 8000);

it("a complete native PTY form survives fragmented UTF-8 and the next partial redraw", async () => {
  await withPopup("edit", async (pty) => {
    const frame = await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);

    const bytes = new TextEncoder().encode(frame);
    const border = bytes.indexOf(0xe2);
    const closingBorder = new TextEncoder().encode(frame.slice(0, frame.lastIndexOf("┘"))).length;
    expect(border).toBeGreaterThan(0);
    const decoder = new TextDecoder();
    let observed = "";
    const listeners = new Set<() => void>();
    const captured = waitFor(
      () => currentForm(observed, /CHECKOUT\s+alpha/, 0),
      (notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    );
    for (const chunk of [bytes.subarray(0, border + 1), bytes.subarray(border + 1, closingBorder + 1)]) {
      observed += decoder.decode(chunk, { stream: true });
      for (const notify of listeners) notify();
      expect(currentForm(observed, /CHECKOUT\s+alpha/, 0)).toBeUndefined();
    }
    observed += decoder.decode(bytes.subarray(closingBorder + 1), { stream: true });
    for (const notify of listeners) notify();
    // ponytail: replay only the PTY chunk boundary, not a second synthetic UI.
    observed += "\x1b[H\x1b[2J┌";
    for (const notify of listeners) notify();
    expect(currentForm(observed, /CHECKOUT\s+alpha/, 0)).toBeUndefined();
    expect(await captured).toBe(frame);
  });
}, 8000);

it("typed Git branch shows an independent directory row and launches on one submit", async () => {
  await withPopup("edit", async (pty) => {
    const initial = await pty.waitForForm(/CHECKOUT\s+alpha/);
    expect(initial).toContain("MODE");
    expect(initial).not.toContain("OPTIONS");
    expect(initial).not.toContain("  DIRECTORY  ");
    pty.write("\t\t\r");
    await pty.waitForEditor("Checkout (");
    const beforeBranch = pty.output().length;
    pty.write("feature/free\r");
    const branchFrame = await pty.waitForForm(/CHECKOUT\s+feature\/free/, beforeBranch);
    expect(branchFrame).toMatch(/CHECKOUT\s+feature\/free/);
    expect(branchFrame).toMatch(/DIRECTORY\s+Default/);
    expect(branchFrame).not.toContain("OPTIONS");
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
    pty.write("\t\t\r");
    await pty.waitForEditor("Optional custom checkout directory name");
    const beforeDirectory = pty.output().length;
    pty.write("custom-tree\r");
    await pty.waitForForm(/DIRECTORY\s+custom-tree/, beforeDirectory);
    expect(pty.output()).not.toContain("REVIEW_CALLED");
    pty.write("\x13");
    expect(await pty.exited).toBe(0);
    expect(pty.output()).toContain('"branch":"feature/free"');
    expect(pty.output()).toContain('"worktreeName":"custom-tree"');
    expect(pty.output().match(/REVIEW_CALLED/g)).toHaveLength(1);
    expect(pty.output().match(/LAUNCH_CALLED/g)).toHaveLength(1);
  });
}, 8000);

it("a review warning launches on the first submit", async () => {
  await withPopup("warning", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\x13");
    await pty.waitForText("Opened with warning");
    expect(pty.output().match(/REVIEW_CALLED/g)).toHaveLength(1);
    expect(pty.output().match(/LAUNCH_CALLED/g)).toHaveLength(1);
    pty.write("\r");
    expect(await pty.exited).toBe(0);
  });
}, 8000);

it("a redirected existing checkout stays blocked on repeated submit", async () => {
  await withPopup("redirect", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\x13");
    await pty.waitForForm("Destination changed; select the checkout again:");
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
    pty.write("\x13");
    // Cancel after the retry so the final output includes everything processed before exit.
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
  });
}, 8000);

it("a new JJ workspace retains its name and launches on one submit with the selected revision", async () => {
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
    expect(await pty.exited).toBe(0);
    expect(pty.output()).toContain('"worktreeName":"task-space"');
    expect(pty.output()).toContain('"revision":"' + "b".repeat(40) + '"');
    expect(pty.output().match(/REVIEW_CALLED/g)).toHaveLength(1);
    expect(pty.output().match(/LAUNCH_CALLED/g)).toHaveLength(1);
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
    expect(await pty.exited).toBe(0);
    expect(pty.output()).toContain('"branch":"main"');
    expect(pty.output().match(/CLONE_LAUNCHED/g)).toHaveLength(1);
  });
}, 8000);

it("a clamped long checkout path launches on the first submit", async () => {
  await withPopup("long", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\x13");
    expect(await pty.exited).toBe(0);
    expect(pty.output().match(/REVIEW_CALLED/g)).toHaveLength(1);
    expect(pty.output().match(/LAUNCH_CALLED/g)).toHaveLength(1);
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
    expect(await pty.exited).toBe(0);
    expect(pty.output()).toContain('"repo":"/safe/alpha"');
    expect(pty.output()).toContain('"worktreeName":"separate-checkout"');
    expect(pty.output().match(/CLONE_LAUNCHED/g)).toHaveLength(1);
  });
}, 8000);

for (const scenario of ["clone-warning", "clone-changed"] as const) {
  it(`${scenario} ${scenario === "clone-warning" ? "launches on first submit" : "stays blocked on retry"}`, async () => {
    await withPopup(scenario, async (pty) => {
      await pty.waitForForm(/CHECKOUT\s+alpha/);
      pty.write("\t\r");
      await pty.waitForEditor("Execution machine");
      pty.write("\x1b[B\r");
      await pty.waitForForm(/CLONE TO\s+\/clones\/alpha/);
      pty.write("\t\r");
      await pty.waitForEditor("Clone to (absolute destination");
      const beforeDestination = pty.output().length;
      pty.write("/safe/alpha\r");
      await pty.waitForForm(/CLONE TO\s+\/safe\/alpha/, beforeDestination);
      pty.write("\x13");
      if (scenario === "clone-changed") {
        await pty.waitForForm("Clone destination changed; edit the destination:");
        expect(pty.output()).not.toContain("CLONE_LAUNCHED");
        pty.write("\x13\x1b");
        expect(await pty.exited).toBe(0);
        expect(pty.output()).not.toContain("CLONE_LAUNCHED");
      } else {
        expect(await pty.exited).toBe(0);
        expect(pty.output().match(/REVIEW_CLONE/g)).toHaveLength(1);
        expect(pty.output().match(/CLONE_LAUNCHED/g)).toHaveLength(1);
        expect(pty.output()).toContain('CLONE_LAUNCHED {"kind":"existing","id":"session-local"} /safe/alpha');
      }
    });
  }, 8000);
}

it("clone launch errors show subprocess diagnostics instead of hiding them behind request arguments", async () => {
  await withPopup("clone-failure", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\t\r");
    await pty.waitForEditor("Execution machine");
    pty.write("\x1b[B\r");
    await pty.waitForForm(/CLONE TO\s+\/clones\/alpha/);
    pty.write("\t\r");
    await pty.waitForEditor("Clone to (absolute destination");
    const beforeDestination = pty.output().length;
    pty.write("/safe/alpha\r");
    await pty.waitForForm(/CLONE TO\s+\/safe\/alpha/, beforeDestination);
    pty.write("\x13");
    await pty.waitForText("Clone needs inspection");
    const frame = pty.output().slice(pty.output().lastIndexOf("\x1b[H\x1b[2J"));
    expect(frame).toContain("Destination request rejected");
    expect(frame).toContain("exited 4");
    expect(frame).toContain("Destination: /safe/alpha");
    expect(frame).not.toContain("request-body-");
    expect(pty.exitCode()).toBeNull();
    pty.write("\r");
    expect(await pty.exited).not.toBe(0);
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
      expect(await pty.exited).toBe(0);
      expect(pty.output()).toContain("REVIEW_CLONE /safe/alpha");
      expect(pty.output().match(/CLONE_LAUNCHED/g)).toHaveLength(1);
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

it("switch paints the selected machine with no actionable old destination while remote discovery waits", async () => {
  await withPopup("switch-pending", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\t\r");
    await pty.waitForEditor("Execution machine");
    const before = pty.output().length;
    pty.write("\x1b[B\r");
    const pending = await pty.waitForForm(/MACHINE\s+Remote machine/, before);
    expect(pending).toContain("Connecting to Remote machine");
    expect(pending).not.toMatch(/CHECKOUT\s+alpha/);
    expect(pending).not.toMatch(/SESSION\s+Session/);
    expect(pending).not.toContain("Host ID: host-local");
    expect(pty.output()).not.toContain("REVIEW_CALLED");
    expect(pty.output()).not.toContain("LAUNCH_CALLED");
    expect(pty.exitCode()).toBeNull();
  });
}, 8000);

it("startup, editor, and error keep the same 16-row frame", async () => {
  await withPopup("connect", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    const firstPaint = pty.output().split("\x1b[H\x1b[2J").find(frame => frame.includes("Discovering projects"))!;
    const startup = firstPaint.slice(0, firstPaint.indexOf("┘") + 1);
    pty.write("\t\r");
    const editor = await pty.waitForEditor("Execution machine");
    const before = pty.output().length;
    pty.write("\x1b[B\r");
    const error = await pty.waitForForm("Remote helper unavailable; install and reload Rex", before);
    const lines = (frame: string) => Bun.stripANSI(frame).replace(/\r/g, "").split("\n");
    const frames = [startup, editor, error].map(lines);
    for (const frame of frames) {
      expect(frame).toHaveLength(16);
      expect(frame[0]).toMatch(/^┌.*┐$/);
      expect(frame[15]).toMatch(/^└.*┘$/);
      expect(frame[14]).toContain(frame === frames[1] ? "Esc back" : "Tab next");
    }
    for (const label of ["PROJECT", "MACHINE"]) {
      const positions = frames.map((frame) => frame.findIndex((line) => line.includes(label)));
      expect(positions[0]).toBeGreaterThan(0);
      expect(positions).toEqual([positions[0], positions[0], positions[0]]);
    }
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);
  });
}, 8000);

it("machine field acceptance preserves the new connection error", async () => {
  await withPopup("connect", async (pty) => {
    await pty.waitForForm(/CHECKOUT\s+alpha/);
    pty.write("\t\r");
    await pty.waitForText("Execution machine");
    const before = pty.output().length;
    pty.write("\x1b[B\r");
    const recovered = await pty.waitForForm("Remote helper unavailable; install and reload Rex", before);
    expect(recovered).toMatch(/MACHINE\s+Remote machine/);
    expect(recovered).not.toMatch(/CHECKOUT\s+alpha/);
    expect(recovered).not.toMatch(/SESSION\s+Session/);
    expect(recovered).not.toContain("Host ID: host-local");
    expect(pty.output()).not.toContain("REVIEW_CALLED");
    pty.write("\x1b");
    expect(await pty.exited).toBe(0);
  });
}, 8000);
