import { afterEach, expect, it } from "@effect/vitest";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { loadConfig, resolveWorktreeRoot } from "../src/config.ts";
import {
  cloneRepository,
  cloneSource,
  createWorktree,
  listBranches,
  listWorktrees,
  origin,
  planWorktree,
  project,
  remoteBranchHead,
  remoteBranches,
  repository,
  safeOrigin,
} from "../src/git.ts";
import { discoverProjects } from "../src/repositories.ts";
import { ServerHostIdSchema, SessionIdSchema, type GitClonePlan, type Environment } from "../src/contracts.ts";
import { checkCloneParent, cloneDestination, prepareCloneCheckout } from "../src/worktrees.ts";
import * as jj from "../src/jj.ts";

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
  return Effect.gen(function*() {
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
    Effect.gen(function*() {
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
    Effect.gen(function*() {
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
    Effect.gen(function*() {
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
    Effect.gen(function*() {
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
    Effect.gen(function*() {
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
    Effect.gen(function*() {
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
    Effect.gen(function*() {
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
            vcs: "git",
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
    Effect.gen(function*() {
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
    Effect.gen(function*() {
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
    Effect.gen(function*() {
      const { root, repo } = yield* fixture("main project with spaces");
      const linked = join(root, "linked-checkout");
      git(repo, "worktree", "add", "-b", "feature", linked);
      const nested = join(linked, "src");
      yield* Effect.promise(() => mkdir(nested));
      const checkout = yield* repository(nested);
      expect(checkout).toEqual({
        vcs: "git",
        path: linked,
        name: "linked-checkout",
        commonDir: join(repo, ".git"),
      });
      expect(yield* project(nested)).toEqual({
        path: repo,
        vcs: "git",
        name: "main project with spaces",
        commonDir: checkout.commonDir,
      });
      expect(yield* discoverProjects([root], [linked, repo], nested)).toEqual([
        {
          vcs: "git",
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
    Effect.gen(function*() {
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
  Effect.gen(function*() {
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
    Effect.gen(function*() {
      const { root, repo } = yield* fixture();
      const clone = join(root, "another clone");
      git(root, "clone", repo, clone);
      const linked = join(root, "linked checkout");
      git(repo, "worktree", "add", "-b", "linked", linked);
      const configDirectory = join(root, "configuration", "rex");
      const previous = process.env.REX_WORKTREES_CONFIG;
      process.env.REX_WORKTREES_CONFIG = JSON.stringify({
        directory: configDirectory,
        config: {
          worktreeRoot: "../../global",
          projects: [{ path: "../../linked checkout", worktreeRoot: "../../override" }],
          roots: ["../../"],
        }
      });
      try {
        const override = join(root, "override");
        const global = join(root, "global", "another clone");
        expect(yield* resolveWorktreeRoot(linked)).toBe(override);
        const config = yield* loadConfig;
        expect((yield* discoverProjects(config.roots, config.projects)).map(project => project.path))
          .toContain(repo);
        expect(yield* resolveWorktreeRoot(repo)).toBe(override);
        expect(yield* resolveWorktreeRoot(clone)).toBe(global);
        process.env.REX_WORKTREES_CONFIG = JSON.stringify({
          directory: configDirectory, config: { worktreeRoot: "../../source-worktrees" }
        });
        expect(yield* resolveWorktreeRoot(repo)).toBe(join(root, "source-worktrees", "repo with space"));
        process.env.REX_WORKTREES_CONFIG = JSON.stringify({
          directory: configDirectory,
          config: { worktreeRoot: "../../global", projects: [{ path: "../../linked checkout", worktreeRoot: "../../override" }] }
        });
        expect(yield* resolveWorktreeRoot(repo)).toBe(override);
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
        if (previous === undefined) delete process.env.REX_WORKTREES_CONFIG;
        else process.env.REX_WORKTREES_CONFIG = previous;
      }
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "explicit roots reject checkout containment, collisions, and symlink escapes before changing Git",
  () =>
    Effect.gen(function*() {
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
    Effect.gen(function*() {
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

it.live("clone uses pushed history, keeps source checkout isolated, and resolves remote branches", () =>
  Effect.gen(function*() {
    const { root, repo: source } = yield* fixture();
    const bare = join(root, "origin.git");
    git(root, "init", "--bare", bare);
    git(source, "remote", "add", "origin", bare);
    git(source, "push", "-u", "origin", "main");
    git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    git(source, "branch", "published", "main");
    git(source, "push", "origin", "published");
    git(source, "branch", "unpublished", "main");
    git(source, "branch", "origin/local-topic", "main");
    git(source, "push", "origin", "main:refs/heads/origin/remote-topic");
    yield* Effect.promise(() => writeFile(join(source, "tracked"), "staged\n"));
    git(source, "add", "tracked");
    yield* Effect.promise(() => writeFile(join(source, "tracked"), "dirty\n"));
    const sourceStatus = git(source, "status", "--porcelain=v1", "-z");
    const sourceHead = git(source, "rev-parse", "HEAD").trim();
    const hostId = Schema.decodeUnknownSync(ServerHostIdSchema)("same-host");
    const described = yield* cloneSource(source, hostId);
    expect(described.branches).toEqual(expect.arrayContaining(["main", "published", "unpublished", "origin/local-topic", "origin/remote-topic"]));
    expect(described.url).toBe(bare);
    const destination = join(root, "destination");
    yield* cloneRepository(described.url, destination);
    expect((yield* repository(destination)).path).toBe(destination);
    expect(yield* origin(destination, true)).toBe(bare);
    expect(yield* remoteBranches(destination)).toContain("published");
    expect(yield* remoteBranches(destination)).toContain("origin/remote-topic");
    expect(yield* remoteBranches(destination)).not.toContain("origin/local-topic");
    expect((yield* remoteBranchHead(destination, "origin/remote-topic")).trim()).toBe(sourceHead);
    expect(yield* remoteBranches(destination)).not.toContain("unpublished");
    expect((yield* remoteBranchHead(destination, "published")).trim()).toBe(sourceHead);
    const published = yield* createWorktree(destination, "published", { startPoint: yield* remoteBranchHead(destination, "published"), worktreeName: "reviewed" });
    expect(published.path).toBe(`${destination}.worktrees/reviewed`);
    expect(git(published.path, "rev-parse", "HEAD").trim()).toBe(sourceHead);
    expect(git(destination, "branch", "--list", "unpublished")).toBe("");
    expect(git(source, "status", "--porcelain=v1", "-z")).toBe(sourceStatus);
    expect(git(source, "rev-parse", "HEAD").trim()).toBe(sourceHead);
    expect(yield* Effect.promise(() => readFile(join(source, "tracked"), "utf8"))).toBe("dirty\n");
    expect(yield* Effect.promise(() => readFile(join(destination, "tracked"), "utf8"))).toBe("base\n");
  }).pipe(Effect.provide(BunServices.layer))
);

it("rejects credential-bearing and cross-host local origin URLs without echoing rejected values", () => {
  for (const secret of ["https://user:password@example.org/repo.git", "https://example.org/repo.git?token=secret", "ssh://user:password@example.org/repo", "ext::sh -c secret"]) {
    expect(() => safeOrigin(secret, false)).toThrow("Unsafe origin URL");
  }
  expect(() => safeOrigin("/source/local.git", false)).toThrow("Local source origins require the same Rex host");
  expect(safeOrigin("git@example.org:org/repo.git", false)).toBe("git@example.org:org/repo.git");
});

it.live("clone destination rejects bare and separate Git directories without touching their metadata", () =>
  Effect.gen(function*() {
    const { root, repo: source } = yield* fixture();
    const bare = join(root, "bare.git");
    git(root, "init", "--bare", bare);
    const separate = join(root, "metadata");
    git(root, "clone", `--separate-git-dir=${separate}`, source, join(root, "checkout"));
    for (const metadata of [bare, separate]) {
      const before = yield* Effect.promise(() => readFile(join(metadata, "HEAD")));
      const error = yield* Effect.flip(cloneDestination(join(metadata, "nested"), source));
      expect(error.message).toContain("Git metadata");
      expect(yield* Effect.promise(() => readFile(join(metadata, "HEAD")))).toEqual(before);
      yield* Effect.promise(() => expect(access(join(metadata, "nested"))).rejects.toThrow());
    }
  }).pipe(Effect.provide(BunServices.layer))
);

it("empty XDG_STATE_HOME uses the default state directory without changing the test process", async () => {
  const home = await mkdtemp(join(tmpdir(), "rex-clone-state-"));
  temporary.push(home);
  const script = `
    import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
    import { BunServices } from ${JSON.stringify(import.meta.resolve("@effect/platform-bun"))};
    import { rememberCloneRoot, rememberedCloneRoot } from ${JSON.stringify(new URL("../src/state.ts", import.meta.url).href)};
    const parent = process.env.HOME + "/parent";
    await Effect.runPromise(rememberCloneRoot(parent).pipe(Effect.provide(BunServices.layer)));
    if (await Effect.runPromise(rememberedCloneRoot().pipe(Effect.provide(BunServices.layer))) !== parent) throw new Error("Remembered root mismatch");
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, HOME: home, XDG_STATE_HOME: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  expect(await readFile(join(home, ".local", "state", "rex-worktrees", "clone-root.json"), "utf8"))
    .toBe(JSON.stringify({ cloneRoot: join(home, "parent") }));
});

it.live.skipIf(process.getuid?.() === 0)("clone planning checks the nearest existing parent without creating directories", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "rex-clone-parent-")));
    temporary.push(root);
    const readonly = join(root, "readonly");
    yield* Effect.promise(() => mkdir(readonly));
    const destination = join(readonly, "nested", "repo");
    try {
      yield* Effect.promise(() => chmod(readonly, 0o500));
      const error = yield* Effect.flip(checkCloneParent(destination));
      expect(error.message).toContain(destination);
      expect(error.message).toContain(readonly);
      expect(error.cause).toBeDefined();
      yield* Effect.promise(() => expect(access(join(readonly, "nested"))).rejects.toThrow());
    } finally {
      yield* Effect.promise(() => chmod(readonly, 0o700));
    }
  }).pipe(Effect.provide(BunServices.layer))
);

it("accepts credential-free SSH user and bracketed IPv6 locators", () => {
  expect(safeOrigin("ssh://deploy@[2001:db8::1]/team/repo.git", false)).toBe("ssh://deploy@[2001:db8::1]/team/repo.git");
  expect(safeOrigin("deploy@git.example.org:team/repo.git", false)).toBe("deploy@git.example.org:team/repo.git");
  expect(safeOrigin("https://example.org/team/repo.git", false)).toBe("https://example.org/team/repo.git");
});

it.live("clone checkout task keeps pushed branches and rejects unpushed, colliding, and symlinked destinations", () =>
  Effect.gen(function*() {
    const { root, repo: source } = yield* fixture();
    const bare = join(root, "origin.git");
    git(root, "init", "--bare", bare);
    git(source, "remote", "add", "origin", bare);
    git(source, "push", "origin", "main");
    git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    git(source, "branch", "published");
    git(source, "push", "origin", "published");
    git(source, "branch", "unpushed");
    const hostId = Schema.decodeUnknownSync(ServerHostIdSchema)("fixture-host");
    const sessionId = Schema.decodeUnknownSync(SessionIdSchema)("fixture-session");
    const makePlan = (repo: string, branch: string, branchMode: GitClonePlan["input"]["branchMode"]): GitClonePlan => ({
      vcs: "git", hostId, repo, existing: false, label: "Clone & Open",
      input: { vcs: "git", source: { vcs: "git", url: bare, sourceHostId: hostId, branches: ["main", "published", "unpushed"] }, repo, session: { kind: "existing", id: sessionId }, name: "Task", branch, branchMode }
    });
    const repo = join(root, "cloned");
    const previousConfig = process.env.REX_WORKTREES_CONFIG;
    process.env.REX_WORKTREES_CONFIG = JSON.stringify({
      directory: root, config: { worktreeRoot: join(root, "destination-worktrees") }
    });
    try {
      const prepared = yield* prepareCloneCheckout(makePlan(repo, "published", "existing"));
      expect(prepared.repo.commonDir).toBe(join(repo, ".git"));
      expect(prepared.cwd).toBe(join(root, "destination-worktrees", "cloned", "published"));
      expect(git(prepared.cwd, "symbolic-ref", "--short", "HEAD").trim()).toBe("published");
      expect(git(source, "branch", "--show-current").trim()).toBe("main");
      const missing = join(root, "missing-branch");
      expect((yield* Effect.flip(prepareCloneCheckout(makePlan(missing, "unpushed", "existing")))).message).toContain("not pushed");
      expect((yield* repository(missing)).path).toBe(missing);
      const collision = join(root, "collision");
      yield* Effect.promise(() => mkdir(collision));
      yield* Effect.promise(() => writeFile(join(collision, "keep"), "unchanged"));
      yield* Effect.flip(prepareCloneCheckout(makePlan(collision, "published", "existing")));
      expect(yield* Effect.promise(() => readFile(join(collision, "keep"), "utf8"))).toBe("unchanged");
      const link = join(root, "linked");
      yield* Effect.promise(() => symlink(collision, link));
      yield* Effect.flip(prepareCloneCheckout(makePlan(join(link, "nested"), "published", "existing")));
      expect(yield* Effect.promise(() => readFile(join(collision, "keep"), "utf8"))).toBe("unchanged");
    } finally {
      if (previousConfig === undefined) delete process.env.REX_WORKTREES_CONFIG;
      else process.env.REX_WORKTREES_CONFIG = previousConfig;
    }
  }).pipe(Effect.provide(BunServices.layer))
);

it.live("existing clone checkout pins repository identity and default origin base", () =>
  Effect.gen(function*() {
    const { root, repo: source } = yield* fixture();
    const bare = join(root, "origin.git");
    git(root, "init", "--bare", bare);
    git(source, "remote", "add", "origin", bare);
    git(source, "push", "origin", "main");
    git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    const repo = join(root, "existing");
    git(root, "clone", bare, repo);
    const original = yield* repository(repo);
    const base = git(repo, "rev-parse", "refs/remotes/origin/HEAD").trim();
    git(repo, "config", "user.name", "Rex Tests");
    git(repo, "config", "user.email", "rex@example.test");
    git(repo, "switch", "-c", "local-feature");
    yield* Effect.promise(() => writeFile(join(repo, "tracked"), "feature-only\n"));
    git(repo, "add", "tracked");
    git(repo, "commit", "-m", "feature-only");
    const feature = git(repo, "rev-parse", "HEAD").trim();
    const hostId = Schema.decodeUnknownSync(ServerHostIdSchema)("fixture-host");
    const sessionId = Schema.decodeUnknownSync(SessionIdSchema)("fixture-session");
    const plan: GitClonePlan = {
      vcs: "git", hostId, repo, existing: true, commonDir: original.commonDir, base, label: "Open existing repository",
      input: { vcs: "git", source: { vcs: "git", url: bare, sourceHostId: hostId, branches: ["main"] }, repo, session: { kind: "existing", id: sessionId }, name: "Task", branch: "new-from-default", branchMode: "create" }
    };
    const previousConfig = process.env.REX_WORKTREES_CONFIG;
    process.env.REX_WORKTREES_CONFIG = JSON.stringify({ directory: root, config: {} });
    try {
      const prepared = yield* prepareCloneCheckout(plan);
      expect(git(prepared.cwd, "rev-parse", "HEAD").trim()).toBe(base);
      expect(git(repo, "rev-parse", "HEAD").trim()).toBe(feature);
      expect((yield* Effect.flip(prepareCloneCheckout({ ...plan, input: { ...plan.input, branch: "main" } }))).message).toContain("already exists");
      const displaced = join(root, "original");
      yield* Effect.promise(() => rename(repo, displaced));
      git(root, "clone", `--separate-git-dir=${join(root, "replacement-metadata")}`, bare, repo);
      expect((yield* Effect.flip(prepareCloneCheckout({ ...plan, input: { ...plan.input, branch: "replacement-test" } }))).message).toContain("identity changed");
      expect(git(repo, "branch", "--list", "replacement-test")).toBe("");
    } finally {
      if (previousConfig === undefined) delete process.env.REX_WORKTREES_CONFIG;
      else process.env.REX_WORKTREES_CONFIG = previousConfig;
    }
  }).pipe(Effect.provide(BunServices.layer))
);

it.live("JJ clone checkout creates a named workspace at a source-resolved published base", () =>
  Effect.gen(function*() {
    const { root, repo: source } = yield* fixture();
    const bare = join(root, "origin.git");
    git(root, "init", "--bare", bare);
    git(source, "push", bare, "main");
    git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    const previous = { JJ_CONFIG: process.env.JJ_CONFIG, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, REX_WORKTREES_CONFIG: process.env.REX_WORKTREES_CONFIG };
    try {
      process.env.HOME = join(root, "jj-home");
      process.env.XDG_CONFIG_HOME = join(root, "jj-config");
      process.env.JJ_CONFIG = join(root, "jj-config.toml");
      process.env.REX_WORKTREES_CONFIG = JSON.stringify({ directory: root, config: {} });
      yield* Effect.promise(() => mkdir(process.env.HOME!));
      yield* Effect.promise(() => writeFile(process.env.JJ_CONFIG!, '[user]\nname = "Rex Tests"\nemail = "rex@example.test"\n'));
      const sourceRepo = join(root, "jj-source");
      yield* jj.cloneRepository(bare, sourceRepo);
      const revision = yield* jj.resolveRevision(sourceRepo, "@-");
      const hostId = Schema.decodeUnknownSync(ServerHostIdSchema)("fixture-host");
      const sessionId = Schema.decodeUnknownSync(SessionIdSchema)("fixture-session");
      const destination = join(root, "jj-target");
      const plan = {
        vcs: "jj" as const, hostId, repo: destination, existing: false, label: "Clone & Open",
        input: {
          vcs: "jj" as const, source: {
            vcs: "jj" as const, url: bare, sourceHostId: hostId,
            revisions: [{ expression: revision.commitId, label: "base", revision }], revision
          },
          repo: destination, session: { kind: "existing" as const, id: sessionId }, name: "Task", worktreeName: "fresh", revision: revision.commitId
        },
        base: revision
      };
      const prepared = yield* prepareCloneCheckout(plan);
      expect(prepared.repo.vcs).toBe("jj");
      expect(prepared.cwd).toBe(`${destination}.worktrees/fresh`);
      expect((yield* jj.resolveRevision(prepared.cwd, "@-")).commitId).toBe(revision.commitId);
      expect((yield* jj.listWorkspaces(destination)).map(tree => tree.name)).toContain("fresh");
      const repeated = yield* Effect.exit(prepareCloneCheckout(plan));
      expect(repeated).toMatchObject({ _tag: "Failure" });
    } finally {
      for (const key of ["JJ_CONFIG", "HOME", "XDG_CONFIG_HOME", "REX_WORKTREES_CONFIG"] as const) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }).pipe(Effect.provide(BunServices.layer))
);
