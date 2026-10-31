import { expect, it } from "@effect/vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { BunServices } from "@effect/platform-bun";
import { loadConfig } from "../src/config.ts";

it.live(
  "absent and omitted config roots discover nothing; configured roots and projects are opt-in; invalid types fail",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "rex-config-")),
      );
      const previous = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = root;
      try {
        expect(yield* loadConfig).toEqual({
          roots: [],
          projects: [],
          worktreeRoot: undefined,
          projectRoots: [],
        });
        const directory = join(root, "rex-worktrees");
        yield* Effect.promise(() => mkdir(directory));
        const file = join(directory, "config.json");
        yield* Effect.promise(() =>
          writeFile(
            file,
            JSON.stringify({
              projects: [
                "~/work",
                { path: "../linked", worktreeRoot: "../worktrees/linked" },
              ],
              roots: ["../source"],
              worktreeRoot: "../worktrees",
            }),
          ),
        );
        expect(yield* loadConfig).toEqual({
          roots: [join(root, "source")],
          projects: [join(process.env.HOME!, "work"), join(root, "linked")],
          worktreeRoot: join(root, "worktrees"),
          projectRoots: [
            {
              path: join(root, "linked"),
              worktreeRoot: join(root, "worktrees", "linked"),
            },
          ],
        });
        yield* Effect.promise(() =>
          writeFile(
            file,
            JSON.stringify({ projects: [join(root, "explicit")] }),
          ),
        );
        expect(yield* loadConfig).toEqual({
          roots: [],
          projects: [join(root, "explicit")],
          worktreeRoot: undefined,
          projectRoots: [],
        });
        yield* Effect.promise(() =>
          writeFile(file, JSON.stringify({ roots: 42 })),
        );
        yield* Effect.flip(loadConfig);
      } finally {
        if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previous;
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(BunServices.layer)),
);
