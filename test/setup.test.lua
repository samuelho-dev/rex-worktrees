return function(root)
  local s, setup, config, state = require("runtime"), require("setup"), require("config"), require("state")
  local fs, path = s.fs, s.path
  local dir = root .. "/setup"
  local home, init, source, legacy = dir .. "/home", dir .. "/rex/init.lua", dir .. "/binary", dir .. "/old/config.json"
  fs.makeDirectory(dir .. "/rex", { recursive = true })
  fs.makeDirectory(dir .. "/old", { recursive = true })
  fs.writeFileString(source, "binary-v1")
  local custom =
    '-- user settings\nrequire("rex-worktrees").setup({ roots = { "~/Projects" } })\nrex.action{ name = "custom" }\n'
  fs.writeFileString(init, custom)
  local lua =
    "-- rex-worktrees: managed module\nlocal installed_rex_bin_dir = false\nlocal installed_path_env = false\nlocal installed_bin = false\nlocal installed_config_dir = false\nreturn {}\n"
  local options = {
    source = source,
    home = home,
    configPath = init,
    legacyConfigPath = legacy,
    lua = lua,
    rexBinDir = dir .. "/rex-cli",
  }
  fs.writeFileString(legacy, '{"roots":["/legacy"]}')
  assert(not pcall(setup.installSetup, options))
  assert(fs.readFileString(init) == custom and fs.readFileString(legacy) == '{"roots":["/legacy"]}')
  fs.remove(legacy)
  local installed = setup.installSetup(options)
  assert(fs.readFileString(init) == custom and fs.readFileString(installed.bin) == "binary-v1")
  fs.writeFileString(source, "binary-v2")
  setup.installSetup(options)
  assert(fs.readFileString(installed.bin) == "binary-v2" and fs.readFileString(init) == custom)
  local init2 = dir .. "/rex/other.lua"
  fs.writeFileString(
    init2,
    '-- other settings\n-- BEGIN rex-worktrees\nrequire("rex-worktrees").setup()\n-- END rex-worktrees\n'
  )
  fs.makeDirectory(dir .. "/old")
  fs.writeFileString(legacy, '{"roots":["../projects"],"projects":[{"path":"./repo","worktreeRoot":"../trees"}]}')
  local initial = fs.readFileString(init2)
  fs.makeDirectory(legacy .. ".backup")
  assert(
    not pcall(
      setup.installSetup,
      {
        source = source,
        home = home,
        configPath = init2,
        legacyConfigPath = legacy,
        lua = lua,
        rexBinDir = dir .. "/rex-cli",
      }
    )
  )
  assert(fs.readFileString(init2) == initial and fs.readFileString(legacy):find("../projects", 1, true))
  fs.remove(legacy .. ".backup")
  fs.writeFileString(legacy .. ".backup", "old backup")
  assert(
    not pcall(
      setup.installSetup,
      {
        source = dir .. "/missing",
        home = home,
        configPath = init2,
        legacyConfigPath = legacy,
        lua = lua,
        rexBinDir = dir .. "/rex-cli",
      }
    )
  )
  assert(fs.readFileString(init2) == initial and fs.readFileString(legacy .. ".backup") == "old backup")
  local migrated = setup.installSetup({
    source = source,
    home = home,
    configPath = init2,
    legacyConfigPath = legacy,
    lua = lua,
    rexBinDir = dir .. "/rex-cli",
  })
  assert(migrated.migrated and not fs.exists(legacy))
  local text = fs.readFileString(init2)
  assert(
    text:find(dir .. "/projects", 1, true)
      and text:find(dir .. "/trees", 1, true)
      and text:find(dir .. "/old/repo", 1, true)
  )
  local specialDir, specialInit, specialLegacy =
    dir .. "/special", dir .. "/special/init.lua", dir .. "/special-old/config.json"
  fs.makeDirectory(specialDir)
  fs.makeDirectory(dir .. "/special-old")
  fs.writeFileString(specialInit, '-- BEGIN rex-worktrees\nrequire("rex-worktrees").setup()\n-- END rex-worktrees\n')
  fs.writeFileString(
    specialLegacy,
    s.json.encode({ roots = { dir .. "/del\127", dir .. "/soft­hyphen", dir .. "/zero​width" } })
  )
  assert(
    setup.installSetup({
      source = source,
      home = dir .. "/special-home",
      configPath = specialInit,
      legacyConfigPath = specialLegacy,
      lua = lua,
      rexBinDir = dir .. "/rex-cli",
    }).migrated
  )
  local generated = fs.readFileString(specialInit)
  local compiled, errorMessage = load(generated, "@generated-init.lua", "t")
  assert(compiled, errorMessage)
  local linkedInit, linkedTarget = dir .. "/rex/linked.lua", dir .. "/linked-target.lua"
  fs.writeFileString(linkedTarget, "-- preserved linked config\n")
  local link = s.capture({ "ln", "-s", linkedTarget, linkedInit })
  assert(link.ok, link.stderr)
  local linkedOptions = {
    source = source,
    home = dir .. "/linked-home",
    configPath = linkedInit,
    lua = lua,
    rexBinDir = dir .. "/rex-cli",
    allowLinkedConfig = false,
  }
  assert(not pcall(setup.installSetup, linkedOptions))
  assert(fs.readFileString(linkedTarget) == "-- preserved linked config\n")
  linkedOptions.allowLinkedConfig = true
  setup.installSetup(linkedOptions)
  assert(fs.lstat(linkedInit).type == "SymbolicLink")
  assert(fs.readFileString(linkedTarget):find("-- preserved linked config", 1, true))
  local conflictHome, conflictInit = dir .. "/conflict-home", dir .. "/conflict.lua"
  fs.makeDirectory(conflictHome .. "/.local/bin", { recursive = true })
  fs.writeFileString(conflictInit, "-- untouched\n")
  link = s.capture({ "ln", "-s", source, conflictHome .. "/.local/bin/rex-worktrees" })
  assert(link.ok, link.stderr)
  assert(
    not pcall(
      setup.installSetup,
      { source = source, home = conflictHome, configPath = conflictInit, lua = lua, rexBinDir = dir .. "/rex-cli" }
    )
  )
  assert(
    fs.lstat(conflictHome .. "/.local/bin/rex-worktrees").type == "SymbolicLink"
      and fs.readFileString(conflictInit) == "-- untouched\n"
  )
  local managedHome, managedInit, managedBin = dir .. "/managed-home", dir .. "/managed/init.lua", dir .. "/managed-bin"
  fs.makeDirectory(dir .. "/managed")
  fs.writeFileString(managedInit, custom)
  fs.chmod(source, 493)
  link = s.capture({ "ln", "-s", source, managedBin })
  assert(link.ok, link.stderr)
  local managed = setup.installSetup({
    source = source,
    home = managedHome,
    configPath = managedInit,
    lua = lua,
    rexBinDir = dir .. "/rex-cli",
    managedBin = managedBin,
  })
  assert(managed.bin == managedBin and fs.lstat(managedBin).type == "SymbolicLink")
  assert(fs.readFileString(managedInit) == custom and not fs.exists(managedHome .. "/.local/bin/rex-worktrees"))
  local replacement = dir .. "/replacement"
  fs.writeFileString(replacement, "other-version")
  fs.remove(managedBin)
  link = s.capture({ "ln", "-s", replacement, managedBin })
  assert(link.ok, link.stderr)
  assert(
    not pcall(
      setup.installSetup,
      {
        source = source,
        home = managedHome,
        configPath = managedInit,
        lua = lua,
        rexBinDir = dir .. "/rex-cli",
        managedBin = managedBin,
      }
    )
  )
  assert(fs.readFileString(managedInit) == custom and fs.readFileString(replacement) == "other-version")
  local posix = require("posix.stdlib")
  local function set(values, base)
    assert(
      posix.setenv("REX_WORKTREES_CONFIG", s.json.encode({ directory = base or dir .. "/rex", config = values }), true)
    )
  end
  set({
    roots = { "../source" },
    projects = { "~/work", { path = "../linked", worktreeRoot = "../trees/linked" } },
    worktreeRoot = "../trees",
  })
  local loaded = config.loadConfig()
  assert(loaded.roots[1] == dir .. "/source" and loaded.projects[1] == root .. "/work")
  assert(loaded.projects[2] == dir .. "/linked" and loaded.projectRoots[1].worktreeRoot == dir .. "/trees/linked")
  fs.makeDirectory(root .. "/config/rex-worktrees", { recursive = true })
  fs.writeFileString(root .. "/config/rex-worktrees/config.json", '{"roots":["/wrong"]}')
  set({ projects = { dir .. "/explicit" } })
  local current = config.loadConfig()
  assert(#current.roots == 0 and current.projects[1] == dir .. "/explicit")
  set({ roots = 42 })
  assert(not pcall(config.loadConfig))
  set(s.json.object(), "relative")
  assert(not pcall(config.loadConfig))
  set(s.json.object())
  local stateRoot = dir .. "/state"
  local previous = dir .. "/previous"
  state.rememberCloneRoot(previous, stateRoot)
  assert(state.rememberedCloneRoot(stateRoot) == previous)
  local emptyState = dir .. "/empty-state"
  local projects = { { path = dir .. "/projects/one" }, { path = dir .. "/projects/two" } }
  assert(config.resolveCloneRoot({}, {}, emptyState) == root)
  assert(config.resolveCloneRoot({}, projects, emptyState) == dir .. "/projects")
  projects[#projects + 1] = { path = dir .. "/elsewhere/three" }
  assert(config.resolveCloneRoot({}, projects, emptyState) == root)
  assert(config.resolveCloneRoot({}, {}, stateRoot) == previous)
  assert(config.resolveCloneRoot({ dir .. "/configured" }, {}, stateRoot) == dir .. "/configured")
  local stateFile = stateRoot .. "/rex-worktrees/clone-root.json"
  for _, invalid in ipairs({ "{bad", '{"cloneRoot":"relative"}', '{"cloneRoot":"/tmp/../tmp"}' }) do
    fs.writeFileString(stateFile, invalid)
    assert(state.rememberedCloneRoot(stateRoot) == nil)
  end
  fs.remove(stateFile)
  fs.makeDirectory(stateFile)
  assert(not pcall(state.rememberedCloneRoot, stateRoot))
  local isolatedHome = dir .. "/isolated-home"
  fs.makeDirectory(isolatedHome)
  local environment = s.environment()
  environment.HOME, environment.XDG_STATE_HOME = isolatedHome, ""
  local child = s.capture({ s.executable(), "test/state-child.lua" }, { env = environment })
  assert(child.ok, child.stderr)
  local remembered = s.json.decode(fs.readFileString(isolatedHome .. "/.local/state/rex-worktrees/clone-root.json"))
  assert(remembered.cloneRoot == isolatedHome .. "/parent")
  local compiled = path.resolve("dist/rex-worktrees")
  local cliHome, cliConfig, cliRex = dir .. "/cli-home", dir .. "/cli/init.lua", dir .. "/cli-rex"
  fs.makeDirectory(cliHome)
  fs.makeDirectory(dir .. "/cli")
  fs.makeDirectory(cliRex)
  fs.writeFileString(cliRex .. "/rex", "#!/bin/sh\nexit 0\n")
  fs.chmod(cliRex .. "/rex", 493)
  local cliEnv = s.environment()
  cliEnv.HOME, cliEnv.REX_BIN_DIR = cliHome, cliRex
  local sourceAttempt = s.capture(
    { s.executable(), "src/main.lua", "setup", "--bin", compiled, "--config", cliConfig },
    { env = cliEnv, timeout = 15 }
  )
  assert(not sourceAttempt.ok and sourceAttempt.stderr:find("packaged rex%-worktrees"))
  assert(not fs.exists(cliConfig))
  local installedCli = s.capture(
    { compiled, "setup", "--bin", compiled, "--config", cliConfig },
    { env = cliEnv, timeout = 15 }
  )
  assert(installedCli.ok, installedCli.stderr)
  assert(fs.readFileString(cliConfig):find('require("rex-worktrees").setup()', 1, true))
  assert(fs.exists(dir .. "/cli/rex-worktrees.lua") and not fs.exists(cliHome .. "/.local/bin/rex-worktrees"))
end
