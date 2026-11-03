import { expect, it } from "@effect/vitest";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { installSetup } from "../src/setup.ts";

it.live(
  "installs independent executable beside local Rex Lua, preserves linked config and reruns once",
  () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "rex-setup-")),
      );
      try {
        const source = join(root, "source-binary");
        const home = join(root, "home");
        const configDir = join(home, ".config", "rex");
        const initTarget = join(root, "custom-init.lua");
        const configPath = join(configDir, "init.lua");
        const original =
          "-- custom Rex settings\nrex.action{ name = 'custom' }\n";
        const lua =
          "-- rex-worktrees: managed module\nlocal installed_rex_bin_dir = false\nlocal installed_path_env = false\nlocal installed_bin = false\nlocal installed_config_dir = false\n-- custom Lua payload\nreturn {}\n";
        const rexBinDir = join(root, "Rex Server.app", "Contents", "MacOS");
        yield* Effect.promise(() => mkdir(configDir, { recursive: true }));
        yield* Effect.promise(() => writeFile(source, "compiled-binary-v1"));
        yield* Effect.promise(() => chmod(source, 0o755));
        yield* Effect.promise(() => writeFile(initTarget, original));
        yield* Effect.promise(() => symlink(initTarget, configPath));
        expect(
          (yield* Effect.flip(
            installSetup({ source, home, configPath, lua, rexBinDir, allowLinkedConfig: false }),
          )).message,
        ).toContain("Refusing linked Rex init");
        expect(yield* Effect.promise(() => readFile(initTarget, "utf8"))).toBe(original);
        const paths = yield* installSetup({
          source,
          home,
          configPath,
          lua,
          rexBinDir,
        });
        expect(
          (yield* Effect.promise(() => lstat(paths.bin))).isSymbolicLink(),
        ).toBe(false);
        expect(yield* Effect.promise(() => readFile(paths.bin, "utf8"))).toBe(
          "compiled-binary-v1",
        );
        expect(
          (yield* Effect.promise(() => lstat(paths.bin))).mode & 0o111,
        ).toBe(0o111);
        expect(
          yield* Effect.promise(() => readFile(paths.luaPath, "utf8")),
        ).toBe(
          lua.replace("local installed_rex_bin_dir = false", `local installed_rex_bin_dir = ${JSON.stringify(rexBinDir)}`)
            .replace("local installed_bin = false", `local installed_bin = ${JSON.stringify(paths.bin)}`)
            .replace("local installed_config_dir = false", `local installed_config_dir = ${JSON.stringify(configDir)}`),
        );
        expect(yield* Effect.promise(() => readlink(configPath))).toBe(
          initTarget,
        );
        yield* Effect.promise(() => writeFile(source, "compiled-binary-v2"));
        expect(yield* Effect.promise(() => readFile(paths.bin, "utf8"))).toBe(
          "compiled-binary-v1",
        );
        yield* installSetup({ source, home, configPath, lua, rexBinDir });
        yield* installSetup({
          source: paths.bin,
          home,
          configPath,
          lua,
          rexBinDir,
        });
        expect(yield* Effect.promise(() => readFile(paths.bin, "utf8"))).toBe(
          "compiled-binary-v2",
        );
        const init = yield* Effect.promise(() => readFile(initTarget, "utf8"));
        expect(init.startsWith(original)).toBe(true);
        expect(init.match(/-- BEGIN rex-worktrees/g)).toHaveLength(1);
        expect(init).toContain(
          'require("rex-worktrees").setup()\n-- END rex-worktrees\n',
        );
        expect(
          yield* Effect.promise(() => readFile(paths.luaPath, "utf8")),
        ).toContain(
          `local installed_rex_bin_dir = ${JSON.stringify(rexBinDir)}`,
        );
        expect(
          yield* Effect.promise(() => readFile(paths.luaPath, "utf8")),
        ).not.toContain(source);
      } finally {
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live("creates an absent Rex init next to the installed Lua module", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "rex-setup-empty-")),
    );
    try {
      const source = join(root, "source");
      const home = join(root, "home");
      const configPath = join(home, ".config", "rex", "init.lua");
      yield* Effect.promise(() => writeFile(source, "compiled"));
      const installed = yield* installSetup({
        source,
        home,
        configPath,
        lua: "-- rex-worktrees: managed module\nlocal installed_rex_bin_dir = false\nlocal installed_path_env = false\nlocal installed_bin = false\nlocal installed_config_dir = false\nreturn {}\n",
        rexBinDir: join(root, "rex-cli"),
      });
      expect(yield* Effect.promise(() => readFile(configPath, "utf8"))).toBe(
        '-- BEGIN rex-worktrees\nrequire("rex-worktrees").setup()\n-- END rex-worktrees\n',
      );
      expect(installed.luaPath).toBe(
        join(home, ".config", "rex", "rex-worktrees.lua"),
      );
    } finally {
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live(
  "refuses malformed registration and destination symlinks before changing files",
  () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "rex-setup-conflict-")),
      );
      try {
        const source = join(root, "source");
        const home = join(root, "home");
        const configPath = join(root, "init.lua");
        const lua =
          "-- rex-worktrees: managed module\nlocal installed_rex_bin_dir = false\nlocal installed_path_env = false\nlocal installed_bin = false\nlocal installed_config_dir = false\nreturn {}\n";
        yield* Effect.promise(() => writeFile(source, "source"));
        yield* Effect.promise(() =>
          writeFile(
            configPath,
            "-- BEGIN rex-worktrees\nchanged registration\n-- END rex-worktrees\n",
          ),
        );
        expect(
          (yield* Effect.flip(
            installSetup({
              source,
              home,
              configPath,
              lua: lua.replace("local installed_rex_bin_dir = false\n", ""),
              rexBinDir: join(root, "rex-cli"),
            }),
          )).message,
        ).toContain("four install placeholders");
        expect(
          (yield* Effect.flip(
            installSetup({
              source,
              home,
              configPath,
              lua: lua + "local installed_rex_bin_dir = false\n",
              rexBinDir: join(root, "rex-cli"),
            }),
          )).message,
        ).toContain("four install placeholders");
        for (const malformed of [
          lua.replace("local installed_path_env = false\n", ""),
          lua + "local installed_path_env = false\n",
        ]) {
          expect(
            (yield* Effect.flip(installSetup({
              source, home, configPath, lua: malformed, rexBinDir: join(root, "rex-cli"),
            }))).message,
          ).toContain("four install placeholders");
        }
        expect(
          yield* Effect.promise(() => readFile(configPath, "utf8")),
        ).toContain("changed registration");
        expect(
          (yield* Effect.flip(
            installSetup({
              source,
              home,
              configPath,
              lua,
              rexBinDir: join(root, "rex-cli"),
            }),
          )).message,
        ).toContain("Malformed rex-worktrees registration");
        yield* Effect.promise(() => writeFile(configPath, "-- preserved\n"));
        const bin = join(home, ".local", "bin", "rex-worktrees");
        yield* Effect.promise(() =>
          mkdir(join(home, ".local", "bin"), { recursive: true }),
        );
        yield* Effect.promise(() => symlink(source, bin));
        expect(
          (yield* Effect.flip(
            installSetup({
              source,
              home,
              configPath,
              lua,
              rexBinDir: join(root, "rex-cli"),
            }),
          )).message,
        ).toContain("Refusing to replace non-file binary");
        expect(yield* Effect.promise(() => readFile(configPath, "utf8"))).toBe(
          "-- preserved\n",
        );
        expect(yield* Effect.promise(() => readlink(bin))).toBe(source);
      } finally {
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(BunServices.layer)),
);

it.live("registers a stable package bin without copying or changing either version", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "rex-setup-managed-")));
    try {
      const home = join(root, "home");
      const configPath = join(home, ".config", "rex", "init.lua");
      const v1 = join(root, "Cellar", "0.1.0", "rex-worktrees");
      const v2 = join(root, "Cellar", "0.1.1", "rex-worktrees");
      const managedBin = join(root, "opt", "rex-worktrees");
      const original = '-- other Rex settings\nrex.action{ name = "custom" }\n';
      const manual = '-- BEGIN rex-worktrees\nrequire("rex-worktrees").setup()\n-- END rex-worktrees\n';
      const lua = "-- rex-worktrees: managed module\nlocal installed_rex_bin_dir = false\nlocal installed_path_env = false\nlocal installed_bin = false\nlocal installed_config_dir = false\nreturn {}\n";
      const rexBinDir = join(root, "rex-cli");
      yield* Effect.promise(() => mkdir(join(root, "Cellar", "0.1.0"), { recursive: true }));
      yield* Effect.promise(() => mkdir(join(root, "Cellar", "0.1.1"), { recursive: true }));
      yield* Effect.promise(() => mkdir(join(root, "opt"), { recursive: true }));
      yield* Effect.promise(() => mkdir(join(home, ".config", "rex"), { recursive: true }));
      yield* Effect.promise(() => writeFile(v1, "first version"));
      yield* Effect.promise(() => writeFile(v2, "second version"));
      yield* Effect.promise(() => chmod(v1, 0o751));
      yield* Effect.promise(() => chmod(v2, 0o711));
      yield* Effect.promise(() => symlink(v1, managedBin));
      yield* Effect.promise(() => writeFile(configPath, original + manual + "-- trailing settings\n"));
      const bytes = yield* Effect.promise(() => readFile(v1));
      const mode = (yield* Effect.promise(() => lstat(v1))).mode & 0o777;
      const installed = yield* installSetup({ source: v1, home, configPath, lua, rexBinDir, managedBin });
      expect(installed.bin).toBe(managedBin);
      expect(yield* Effect.promise(() => readFile(v1))).toEqual(bytes);
      expect((yield* Effect.promise(() => lstat(v1))).mode & 0o777).toBe(mode);
      expect(yield* Effect.promise(() => readlink(managedBin))).toBe(v1);
      expect(yield* Effect.promise(() => lstat(join(home, ".local", "bin")).then(() => true, () => false))).toBe(false);
      const registered = `${original}${manual}-- trailing settings\n`;
      expect(yield* Effect.promise(() => readFile(configPath, "utf8"))).toBe(registered);
      yield* installSetup({ source: v1, home, configPath, lua, rexBinDir, managedBin });
      expect(yield* Effect.promise(() => readFile(configPath, "utf8"))).toBe(registered);
      yield* Effect.promise(() => rm(managedBin));
      yield* Effect.promise(() => symlink(v2, managedBin));
      expect(yield* Effect.promise(() => readFile(managedBin, "utf8"))).toBe("second version");
      expect(yield* Effect.promise(() => readFile(configPath, "utf8"))).toBe(registered);
      expect(yield* Effect.promise(() => readFile(v2, "utf8"))).toBe("second version");
      expect((yield* Effect.promise(() => lstat(v2))).mode & 0o777).toBe(0o711);
      expect((yield* Effect.flip(installSetup({ source: v1, home, configPath, lua, rexBinDir, managedBin }))).message).toContain("must resolve to the running executable");
      expect(yield* Effect.promise(() => readFile(configPath, "utf8"))).toBe(registered);
    } finally {
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("migrates legacy JSON relative to its old directory and keeps its original backup", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "rex-setup-migrate-")));
    try {
      const home = join(root, "home");
      const configPath = join(root, "rex", "init.lua");
      const legacyConfigPath = join(root, "old-settings", "config.json");
      const source = join(root, "bin");
      const lua = "-- rex-worktrees: managed module\nlocal installed_rex_bin_dir = false\nlocal installed_path_env = false\nlocal installed_bin = false\nlocal installed_config_dir = false\nreturn {}\n";
      const old = JSON.stringify({ roots: ["../projects", "~/src"], projects: [{ path: "./repo", worktreeRoot: "../checkouts" }], worktreeRoot: "relative" });
      yield* Effect.promise(() => mkdir(join(root, "rex"), { recursive: true }));
      yield* Effect.promise(() => mkdir(join(root, "old-settings"), { recursive: true }));
      yield* Effect.promise(() => writeFile(source, "binary"));
      yield* Effect.promise(() => writeFile(configPath, "-- other settings\n-- BEGIN rex-worktrees\nrequire(\"rex-worktrees\").setup()\n-- END rex-worktrees\n"));
      yield* Effect.promise(() => writeFile(legacyConfigPath, old));
      const options = { source, home, configPath, legacyConfigPath, lua, rexBinDir: join(root, "rex-cli") };
      expect((yield* installSetup(options)).migrated).toBe(true);
      const init = yield* Effect.promise(() => readFile(configPath, "utf8"));
      expect(init).toContain(`roots = { "${join(root, "projects")}", "${join(home, "src")}" }`);
      expect(init).toContain(`{ path = "${join(root, "old-settings", "repo")}", worktreeRoot = "${join(root, "checkouts")}" }`);
      expect(init).toContain(`worktreeRoot = "${join(root, "old-settings", "relative")}"`);
      expect(yield* Effect.promise(() => readFile(`${legacyConfigPath}.backup`, "utf8"))).toBe(old);
      expect(yield* Effect.promise(() => lstat(legacyConfigPath).then(() => true, () => false))).toBe(false);
      expect((yield* installSetup(options)).migrated).toBe(false);
      expect(yield* Effect.promise(() => readFile(configPath, "utf8"))).toBe(init);
    } finally {
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("preserves custom native setup and rejects conflicting legacy settings before writes", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "rex-setup-custom-")));
    try {
      const home = join(root, "home");
      const configPath = join(root, "init.lua");
      const source = join(root, "bin");
      const legacyConfigPath = join(root, "config.json");
      const lua = "-- rex-worktrees: managed module\nlocal installed_rex_bin_dir = false\nlocal installed_path_env = false\nlocal installed_bin = false\nlocal installed_config_dir = false\nreturn {}\n";
      const custom = '-- user settings\n-- BEGIN rex-worktrees\nrequire("rex-worktrees").setup({ roots = { "~/Projects" }, bin = "/custom/bin" })\n-- END rex-worktrees\n-- rest\n';
      yield* Effect.promise(() => writeFile(source, "binary"));
      yield* Effect.promise(() => writeFile(configPath, custom));
      yield* Effect.promise(() => writeFile(legacyConfigPath, '{"roots":["/legacy"]}'));
      const options = { source, home, configPath, legacyConfigPath, lua, rexBinDir: join(root, "rex-cli") };
      expect((yield* Effect.flip(installSetup(options))).message).toContain("Move roots/projects/worktreeRoot");
      expect(yield* Effect.promise(() => readFile(configPath, "utf8"))).toBe(custom);
      expect(yield* Effect.promise(() => readFile(legacyConfigPath, "utf8"))).toBe('{"roots":["/legacy"]}');
      expect(yield* Effect.promise(() => lstat(join(root, "rex-worktrees.lua")).then(() => true, () => false))).toBe(false);
      yield* Effect.promise(() => rm(legacyConfigPath));
      yield* installSetup(options);
      yield* installSetup(options);
      expect(yield* Effect.promise(() => readFile(configPath, "utf8"))).toBe(custom);
    } finally {
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(BunServices.layer)),
);
