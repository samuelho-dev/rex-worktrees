import { expect, it } from "@effect/vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { BunServices } from "@effect/platform-bun";
import { loadConfig, resolveCloneRoot } from "../src/config.ts";
import { rememberedCloneRoot, rememberCloneRoot } from "../src/state.ts";


it.live("native settings opt into roots and resolve relative paths against the Rex config directory", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "rex-config-")));
    const directory = join(root, "rex");
    const previous = process.env.REX_WORKTREES_CONFIG;
    try {
      yield* Effect.promise(() => mkdir(directory));
      const set = (config: unknown, base = directory) => {
        process.env.REX_WORKTREES_CONFIG = JSON.stringify({ config, directory: base });
      };
      set({});
      expect(yield* loadConfig).toEqual({ roots: [], projects: [], worktreeRoot: undefined, projectRoots: [] });
      set({
        projects: ["~/work", { path: "../linked", worktreeRoot: "../worktrees/linked" }],
        roots: ["../source"], worktreeRoot: "../worktrees"
      });
      expect(yield* loadConfig).toEqual({
        roots: [join(root, "source")],
        projects: [join(process.env.HOME!, "work"), join(root, "linked")],
        worktreeRoot: join(root, "worktrees"),
        projectRoots: [{ path: join(root, "linked"), worktreeRoot: join(root, "worktrees", "linked") }]
      });
      // A stale JSON file must not override native settings.
      yield* Effect.promise(() => mkdir(join(root, "rex-worktrees")));
      yield* Effect.promise(() => writeFile(join(root, "rex-worktrees", "config.json"), JSON.stringify({ roots: ["/wrong"] })));
      set({ projects: [join(root, "explicit")] });
      expect(yield* loadConfig).toEqual({
        roots: [], projects: [join(root, "explicit")], worktreeRoot: undefined, projectRoots: []
      });
      set({ roots: 42 });
      yield* Effect.flip(loadConfig);
      set({}, "relative");
      yield* Effect.flip(loadConfig);
      set({ projects: [{}] });
      yield* Effect.flip(loadConfig);
      process.env.REX_WORKTREES_CONFIG = "{bad";
      yield* Effect.flip(loadConfig);
    } finally {
      if (previous === undefined) delete process.env.REX_WORKTREES_CONFIG;
      else process.env.REX_WORKTREES_CONFIG = previous;
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(BunServices.layer))
);
it.live("clone root precedence and advisory state stay destination-local without touching config", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "rex-clone-state-")));
    const state = join(root, "state");
    const parent = join(root, "previous-clones");
    const projects = [{ path: join(root, "projects", "one") }, { path: join(root, "projects", "two") }];
    try {
      expect(yield* resolveCloneRoot([], [], state)).toBe(process.env.HOME);
      expect(yield* resolveCloneRoot([], projects, state)).toBe(join(root, "projects"));
      expect(yield* resolveCloneRoot([], [...projects, { path: join(root, "elsewhere", "three") }], state)).toBe(process.env.HOME);
      yield* rememberCloneRoot(parent, state);
      expect(yield* rememberedCloneRoot(state)).toBe(parent);
      expect(yield* resolveCloneRoot([], projects, state)).toBe(parent);
      expect(yield* resolveCloneRoot([join(root, "configured")], projects, state)).toBe(join(root, "configured"));
      const file = join(state, "rex-worktrees", "clone-root.json");
      for (const value of ["{bad", JSON.stringify({ cloneRoot: "relative" }), JSON.stringify({ cloneRoot: "/tmp/../tmp" })]) {
        yield* Effect.promise(() => writeFile(file, value));
        expect(yield* rememberedCloneRoot(state)).toBeUndefined();
      }
      yield* Effect.promise(() => rm(file));
      yield* Effect.promise(() => mkdir(file));
      yield* Effect.flip(rememberedCloneRoot(state)); // IO errors aren't malformed advisory records.
    } finally {
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(BunServices.layer))
);
