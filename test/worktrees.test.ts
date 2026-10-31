import { afterEach, expect, it } from "@effect/vitest";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { resolveWorktreeRoot } from "../src/config.ts";
import {
  createWorktree,
  discoverProjects,
  listBranches,
  listWorktrees,
  planWorktree,
  project,
  repository,
} from "../src/git.ts";
import type { Environment } from "../src/contracts.ts";

const temporary: string[] = [];
afterEach(() =>
  Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ),
);

function git(cwd: string, ...args: string[]): string {
  const env: Environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_") && value !== undefined) env[name] = value;
  }
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(
      `${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`,
    );
  return new TextDecoder().decode(result.stdout);
}

function fixture(name = "repo with space") {
  return Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "rex worktrees ")),
    ).pipe(Effect.flatMap((path) => Effect.promise(() => realpath(path))));
    temporary.push(root);
    const repo = join(root, name);
    yield* Effect.promise(() => mkdir(repo));
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Rex Tests");
    git(repo, "config", "user.email", "rex@example.test");
    yield* Effect.promise(() => writeFile(join(repo, "tracked"), "base\n"));
    git(repo, "add", "tracked");
    git(repo, "commit", "-m", "base");
    return { root, repo };
  });
}

it.live(
  "new worktree never switches, stages, or edits the source checkout",
  () =>
    Effect.gen(function* () {
      const { repo } = yield* fixture();
      yield* Effect.promise(() => writeFile(join(repo, "tracked"), "staged\n"));
      git(repo, "add", "tracked");
      yield* Effect.promise(() => writeFile(join(repo, "tracked"), "dirty\n"));
      yield* Effect.promise(() =>
        writeFile(join(repo, "untracked"), "untouched\0bytes"),
      );
      const original = {
        branch: git(repo, "symbolic-ref", "HEAD"),
        head: git(repo, "rev-parse", "HEAD"),
        index: git(repo, "ls-files", "--stage"),
        staged: git(repo, "diff", "--cached", "--binary"),
        status: git(repo, "status", "--porcelain=v1", "-z"),
        tracked: yield* Effect.promise(() => readFile(join(repo, "tracked"))),
        untracked: yield* Effect.promise(() =>
          readFile(join(repo, "untracked")),
        ),
        indexBytes: yield* Effect.promise(() =>
          readFile(join(repo, ".git", "index")),
        ),
      };
      const created = yield* createWorktree(repo, "feature/B");
      expect(created.path).toBe(`${repo}.worktrees/feature/B`);
      expect(created.branch).toBe("feature/B");
      yield* Effect.promise(() =>
        writeFile(join(created.path, "new-file"), "B change\n"),
      );
      git(created.path, "add", "new-file");
      git(created.path, "commit", "-m", "B commit");
      expect(
        yield* Effect.promise(() => readFile(join(repo, ".git", "index"))),
      ).toEqual(original.indexBytes);
      expect(git(repo, "symbolic-ref", "HEAD")).toBe(original.branch);
      expect(git(repo, "rev-parse", "HEAD")).toBe(original.head);
      expect(git(repo, "ls-files", "--stage")).toBe(original.index);
      expect(git(repo, "diff", "--cached", "--binary")).toBe(original.staged);
      expect(git(repo, "status", "--porcelain=v1", "-z")).toBe(original.status);
      expect(
        yield* Effect.promise(() => readFile(join(repo, "tracked"))),
      ).toEqual(original.tracked);
      expect(
        yield* Effect.promise(() => readFile(join(repo, "untracked"))),
      ).toEqual(original.untracked);
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "named checkout path is independent of branch, with no source checkout mutation",
  () =>
    Effect.gen(function* () {
      const { root, repo } = yield* fixture();
      const configuredRoot = join(root, "configured worktrees");
      const source = git(repo, "rev-parse", "HEAD");
      const plan = yield* planWorktree(
        repo,
        "feature/topic",
        configuredRoot,
        "task-name",
      );
      expect(plan).toMatchObject({
        path: join(configuredRoot, "task-name"),
        branch: "feature/topic",
        existing: false,
      });
      const created = yield* createWorktree(repo, "feature/topic", {
        worktreeRoot: configuredRoot,
        worktreeName: "task-name",
        startPoint: source.trim(),
      });
      expect(created.path).toBe(plan.path);
      expect(git(created.path, "symbolic-ref", "--short", "HEAD").trim()).toBe(
        "feature/topic",
      );
      expect(git(repo, "symbolic-ref", "--short", "HEAD").trim()).toBe("main");
      expect(git(repo, "rev-parse", "HEAD")).toBe(source);
      expect(
        (yield* planWorktree(
          repo,
          "feature/topic",
          configuredRoot,
          "another-name",
        )).path,
      ).toBe(created.path);
      expect(
        (yield* createWorktree(repo, "feature/topic", {
          worktreeRoot: configuredRoot,
          worktreeName: "another-name",
        })).path,
      ).toBe(created.path);
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "invalid checkout names cannot escape or mutate the checkout root or Git branches",
  () =>
    Effect.gen(function* () {
      const { root, repo } = yield* fixture();
      const configuredRoot = join(root, "configured worktrees");
      for (const name of [
        "",
        "  ",
        "/absolute",
        "../escape",
        "a/../escape",
        "./task",
        "a//b",
        "a/./b",
        "task\nbad",
        "bad\0name",
        "a\\..\\escape",
      ]) {
        yield* Effect.flip(
          planWorktree(repo, "feature/topic", configuredRoot, name),
        );
        yield* Effect.flip(
          createWorktree(repo, "feature/topic", {
            worktreeRoot: configuredRoot,
            worktreeName: name,
          }),
        );
      }
      expect(git(repo, "branch", "--list", "feature/topic")).toBe("");
      expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
        configuredRoot,
      );
      yield* Effect.promise(() =>
        expect(access(configuredRoot)).rejects.toThrow(),
      );
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "reviewed new branch uses the pinned source commit after HEAD advances",
  () =>
    Effect.gen(function* () {
      const { repo } = yield* fixture();
      const reviewed = git(repo, "rev-parse", "HEAD").trim();
      yield* Effect.promise(() =>
        writeFile(join(repo, "tracked"), "advanced\n"),
      );
      git(repo, "add", "tracked");
      git(repo, "commit", "-m", "advance");
      const source = git(repo, "rev-parse", "HEAD").trim();
      const created = yield* createWorktree(repo, "reviewed", {
        startPoint: reviewed,
      });
      expect(created.head).toBe(reviewed);
      expect(git(created.path, "rev-parse", "HEAD").trim()).toBe(reviewed);
      expect(git(repo, "rev-parse", "HEAD").trim()).toBe(source);
      expect(
        yield* Effect.promise(() =>
          readFile(join(created.path, "tracked"), "utf8"),
        ),
      ).toBe("base\n");
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "reviewed new branch refuses a branch that appeared, even when checked out elsewhere",
  () =>
    Effect.gen(function* () {
      const { repo } = yield* fixture();
      const reviewed = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "branch", "appeared");
      expect(
        (yield* Effect.flip(
          createWorktree(repo, "appeared", { startPoint: reviewed }),
        )).message,
      ).toContain("appeared after review");
      expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
        `${repo}.worktrees/appeared`,
      );
      expect(git(repo, "branch", "--list", "appeared")).toContain("appeared");
      const existing = yield* createWorktree(repo, "appeared");
      expect(
        (yield* Effect.flip(
          createWorktree(repo, "appeared", { startPoint: reviewed }),
        )).message,
      ).toContain("appeared after review");
      expect(git(existing.path, "rev-parse", "HEAD").trim()).toBe(reviewed);
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "reviewed attach refuses to recreate a branch deleted before the task",
  () =>
    Effect.gen(function* () {
      const { repo } = yield* fixture();
      git(repo, "branch", "free");
      git(repo, "branch", "-d", "free");
      expect(
        (yield* Effect.flip(createWorktree(repo, "free", { attachOnly: true })))
          .message,
      ).toContain("disappeared after review");
      expect(git(repo, "branch", "--list", "free")).toBe("");
      expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
        `${repo}.worktrees/free`,
      );
      git(repo, "branch", "free");
      const attached = yield* createWorktree(repo, "free", {
        attachOnly: true,
      });
      expect(attached.branch).toBe("free");
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "existing branches, linked checkouts, and hostile inherited GIT_DIR stay isolated",
  () =>
    Effect.gen(function* () {
      const { root, repo } = yield* fixture("repo with space\nand newline");
      git(repo, "branch", "free");
      expect((yield* listBranches(repo)).sort()).toEqual(["free", "main"]);
      const other = yield* fixture();
      const previousGitDir = process.env.GIT_DIR;
      process.env.GIT_DIR = join(other.repo, ".git");
      try {
        const created = yield* createWorktree(repo, "free");
        expect(created.branch).toBe("free");
        expect(yield* planWorktree(repo, "free")).toMatchObject({
          path: created.path,
          existing: true,
        });
        expect((yield* createWorktree(repo, "free")).path).toBe(created.path);
        const linked = yield* repository(created.path);
        expect(linked.commonDir).toBe(join(repo, ".git"));
        expect((yield* createWorktree(created.path, "nested/new")).path).toBe(
          `${repo}.worktrees/nested/new`,
        );
        const found = yield* discoverProjects([root], [created.path, repo]);
        expect(found).toEqual([
          {
            path: repo,
            name: "repo with space\nand newline",
            commonDir: join(repo, ".git"),
          },
        ]);
        expect(
          (yield* listWorktrees(repo)).map((tree) => tree.branch),
        ).toContain("nested/new");
      } finally {
        if (previousGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previousGitDir;
      }
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "invalid branches, occupied paths, and symlink ancestors fail without replacing data",
  () =>
    Effect.gen(function* () {
      const { root, repo } = yield* fixture();
      for (const name of ["-bad", "../bad", "a/../b", "bad name", "a//b"]) {
        yield* Effect.flip(planWorktree(repo, name));
      }
      yield* Effect.promise(() =>
        mkdir(`${repo}.worktrees`, { recursive: true }),
      );
      yield* Effect.promise(() =>
        writeFile(`${repo}.worktrees/collision`, "do not replace"),
      );
      yield* Effect.flip(createWorktree(repo, "collision"));
      expect(
        yield* Effect.promise(() =>
          readFile(`${repo}.worktrees/collision`, "utf8"),
        ),
      ).toBe("do not replace");
      const outside = join(root, "outside");
      yield* Effect.promise(() => mkdir(outside));
      yield* Effect.promise(() => symlink(outside, `${repo}.worktrees/link`));
      yield* Effect.flip(createWorktree(repo, "link/escape"));
      expect(git(repo, "branch", "--list", "collision")).toBe("");
      const second = yield* fixture();
      yield* Effect.promise(() => symlink(outside, `${second.repo}.worktrees`));
      yield* Effect.flip(createWorktree(second.repo, "outside-parent"));
      expect(git(second.repo, "branch", "--list", "outside-parent")).toBe("");
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "nested context chooses its containing repository without scanning sibling repositories",
  () =>
    Effect.gen(function* () {
      const { root, repo } = yield* fixture();
      const nested = join(repo, "src", "deep");
      yield* Effect.promise(() => mkdir(nested, { recursive: true }));
      const sibling = join(root, "sibling");
      yield* Effect.promise(() => mkdir(sibling));
      git(sibling, "init", "-b", "main");
      expect(
        (yield* discoverProjects([], [], nested)).map(({ path }) => path),
      ).toEqual([repo]);
      expect(yield* discoverProjects([], [], root)).toEqual([]);
      expect(yield* discoverProjects([], [], join(root, "missing"))).toEqual(
        [],
      );
      expect(yield* discoverProjects([], [])).toEqual([]);
      expect(
        (yield* discoverProjects([], [sibling])).map(({ path }) => path),
      ).toEqual([sibling]);
      expect(
        (yield* discoverProjects([root], [])).map(({ path }) => path).sort(),
      ).toEqual([repo, sibling].sort());
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "linked checkout context presents the primary project without changing checkout identity",
  () =>
    Effect.gen(function* () {
      const { root, repo } = yield* fixture("main project with spaces");
      const linked = join(root, "linked-checkout");
      git(repo, "worktree", "add", "-b", "feature", linked);
      const nested = join(linked, "src");
      yield* Effect.promise(() => mkdir(nested));
      const checkout = yield* repository(nested);
      expect(checkout).toEqual({
        path: linked,
        name: "linked-checkout",
        commonDir: join(repo, ".git"),
      });
      expect(yield* project(nested)).toEqual({
        path: repo,
        name: "main project with spaces",
        commonDir: checkout.commonDir,
      });
      expect(yield* discoverProjects([root], [linked, repo], nested)).toEqual([
        {
          path: repo,
          name: "main project with spaces",
          commonDir: checkout.commonDir,
        },
      ]);
      expect((yield* listWorktrees(linked)).map(({ path }) => path)).toEqual([
        repo,
        linked,
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "bare primary retains the accessible checkout under the primary project name",
  () =>
    Effect.gen(function* () {
      const { root, repo } = yield* fixture();
      const bare = join(root, "primary project.git");
      git(root, "init", "--bare", bare);
      git(repo, "push", bare, "main");
      git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
      const linked = join(root, "linked checkout");
      git(bare, "worktree", "add", "-b", "feature", linked, "main");
      const checkout = yield* repository(linked);
      expect(yield* project(linked)).toEqual({
        ...checkout,
        name: "primary project.git",
      });
      expect(yield* discoverProjects([], [], linked)).toEqual([
        { ...checkout, name: "primary project.git" },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live("separate clones of the same remote remain separate projects", () =>
  Effect.gen(function* () {
    const { root, repo } = yield* fixture();
    const clone = join(root, "another clone");
    git(root, "clone", repo, clone);
    const projects = yield* discoverProjects([], [repo, clone]);
    expect(projects.map(({ path, name }) => ({ path, name }))).toEqual([
      { path: repo, name: "repo with space" },
      { path: clone, name: "another clone" },
    ]);
    expect(projects[0]!.commonDir).not.toBe(projects[1]!.commonDir);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "host-local roots match linked checkouts by Git identity, not clone URL or current directory",
  () =>
    Effect.gen(function* () {
      const { root, repo } = yield* fixture();
      const clone = join(root, "another clone");
      git(root, "clone", repo, clone);
      const linked = join(root, "linked checkout");
      git(repo, "worktree", "add", "-b", "linked", linked);
      const configHome = join(root, "configuration");
      const configDirectory = join(configHome, "rex-worktrees");
      yield* Effect.promise(() => mkdir(configDirectory, { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(
          join(configDirectory, "config.json"),
          JSON.stringify({
            worktreeRoot: "../../global",
            projects: [
              { path: "../../linked checkout", worktreeRoot: "../../override" },
            ],
          }),
        ),
      );
      const previous = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = configHome;
      try {
        const override = join(root, "override");
        const global = join(root, "global", "another clone");
        expect(yield* resolveWorktreeRoot(linked)).toBe(override);
        expect(yield* resolveWorktreeRoot(repo)).toBe(override);
        expect(yield* resolveWorktreeRoot(clone)).toBe(global);
        const planned = yield* planWorktree(linked, "feature/nested", override);
        expect(planned.path).toBe(join(override, "feature", "nested"));
        const created = yield* createWorktree(linked, "feature/nested", {
          worktreeRoot: override,
        });
        expect(created.path).toBe(planned.path);
        expect((yield* repository(created.path)).commonDir).toBe(
          join(repo, ".git"),
        );
        expect((yield* planWorktree(repo, "linked", override)).path).toBe(
          linked,
        );
        expect(
          (yield* Effect.flip(
            planWorktree(repo, "inside-linked", join(linked, "nested")),
          )).message,
        ).toContain("inside checkout");
        expect(
          (yield* planWorktree(clone, "feature/nested", global)).path,
        ).toBe(join(global, "feature", "nested"));
        const cloneTree = yield* createWorktree(clone, "feature/nested", {
          worktreeRoot: global,
        });
        expect((yield* repository(cloneTree.path)).commonDir).toBe(
          join(clone, ".git"),
        );
      } finally {
        if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previous;
      }
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "explicit roots reject checkout containment, collisions, and symlink escapes before changing Git",
  () =>
    Effect.gen(function* () {
      const { root, repo } = yield* fixture();
      expect(
        (yield* Effect.flip(planWorktree(repo, "relative", "relative/root")))
          .message,
      ).toContain("absolute");
      expect(
        (yield* Effect.flip(
          createWorktree(repo, "nested", {
            worktreeRoot: join(repo, "nested"),
          }),
        )).message,
      ).toContain("inside checkout");
      expect(git(repo, "branch", "--list", "nested")).toBe("");
      const differentlyCased = join(root, "REPO WITH SPACE");
      const casing = yield* Effect.promise(() =>
        stat(differentlyCased).catch(() => undefined),
      );
      const actual = yield* Effect.promise(() => stat(repo));
      if (casing && casing.dev === actual.dev && casing.ino === actual.ino) {
        expect(
          (yield* Effect.flip(
            createWorktree(repo, "alias", {
              worktreeRoot: join(differentlyCased, "new"),
            }),
          )).message,
        ).toContain("aliases a checkout");
        yield* Effect.promise(() =>
          expect(access(join(repo, "new"))).rejects.toThrow(),
        );
        expect(git(repo, "branch", "--list", "alias")).toBe("");
      }
      const destination = join(root, "external");
      yield* Effect.promise(() => mkdir(destination));
      yield* Effect.promise(() =>
        writeFile(join(destination, "occupied"), "keep"),
      );
      expect(
        (yield* Effect.flip(
          createWorktree(repo, "occupied", { worktreeRoot: destination }),
        )).message,
      ).toContain("already exists");
      expect(
        yield* Effect.promise(() =>
          readFile(join(destination, "occupied"), "utf8"),
        ),
      ).toBe("keep");
      const outside = join(root, "outside");
      yield* Effect.promise(() => mkdir(outside));
      yield* Effect.promise(() => symlink(outside, join(root, "alias")));
      expect(
        (yield* Effect.flip(
          createWorktree(repo, "escape", {
            worktreeRoot: join(root, "alias", "subdir"),
          }),
        )).message,
      ).toContain("Symlinked");
      expect(git(repo, "branch", "--list", "escape")).toBe("");
      const pinned = git(repo, "rev-parse", "HEAD").trim();
      const created = yield* createWorktree(repo, "pinned", {
        startPoint: pinned,
        worktreeRoot: destination,
      });
      expect(created.path).toBe(join(destination, "pinned"));
      expect(
        (yield* Effect.flip(
          createWorktree(repo, "pinned", {
            startPoint: pinned,
            worktreeRoot: destination,
          }),
        )).message,
      ).toContain("appeared after review");
      expect(
        (yield* Effect.flip(
          createWorktree(repo, "missing", {
            attachOnly: true,
            worktreeRoot: destination,
          }),
        )).message,
      ).toContain("disappeared after review");
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "a branch destination cannot enter a separate Git metadata directory",
  () =>
    Effect.gen(function* () {
      const { root, repo } = yield* fixture();
      const metadata = join(root, "metadata");
      const checkout = join(root, "separate checkout");
      git(root, "clone", `--separate-git-dir=${metadata}`, repo, checkout);
      yield* Effect.flip(
        createWorktree(checkout, "metadata/new", { worktreeRoot: root }),
      );
      yield* Effect.promise(() =>
        expect(access(join(metadata, "new"))).rejects.toThrow(),
      );
      expect(git(checkout, "branch", "--list", "metadata/new")).toBe("");
    }).pipe(Effect.provide(BunServices.layer)),
);
