local system = require("runtime")
local contracts = require("contracts")
local fs, path = system.fs, system.path

local marker = "-- rex-worktrees: managed module\n"
local begin = "-- BEGIN rex-worktrees\n"
local ending = "-- END rex-worktrees\n"
local manual = begin .. 'require("rex-worktrees").setup()\n' .. ending
local placeholders = {
  "local installed_rex_bin_dir = false",
  "local installed_path_env = false",
  "local installed_bin = false",
  "local installed_config_dir = false",
}

local function literal(value) return string.format("%q", value) end

local function info(filename)
  local ok, value = system.try(function() return fs.lstat(filename) end)
  if ok then return value end
  if system.missing(value) then return nil end
  error(value, 0)
end

local function managed(registration)
  if not registration or registration:sub(1, #begin) ~= begin or registration:sub(-#ending) ~= ending then
    return false
  end
  local body = registration:sub(#begin + 1, -#ending - 1)
  local encoded = body:match('^require%("rex%-worktrees"%)%.setup%(%{ bin = (.+) %}%)\n$')
  if not encoded then return false end
  local ok, value = system.try(function() return system.json.decode(encoded) end)
  return ok and type(value) == "string"
end

local function hasRequire(text) return text:match("require%s*%(?%s*['\"]rex%-worktrees['\"]%s*%)?") ~= nil end

local function hasSetup(text) return text:match("require%s*%(?%s*['\"]rex%-worktrees['\"]%s*%)?%.setup%s*%(") ~= nil end

local function atomic(destination, write)
  local temporary = path.join(path.dirname(destination), ".rex-worktrees-" .. system.uuid() .. ".tmp")
  local ok, err = system.try(function()
    write(temporary)
    fs.rename(temporary, destination)
  end)
  local cleaned, cleanupError = system.try(function() fs.remove(temporary, { force = true }) end)
  if not ok then error(err, 0) end
  if not cleaned then error(cleanupError, 0) end
end

local function installSetup(options)
  local source, home, configPath = options.source, options.home, options.configPath
  local module, rexBinDir = options.lua, options.rexBinDir
  local managedBin, legacyPath = options.managedBin, options.legacyConfigPath
  if
    not path.isAbsolute(configPath)
    or not path.isAbsolute(home)
    or not path.isAbsolute(source)
    or not path.isAbsolute(rexBinDir)
    or (managedBin and not path.isAbsolute(managedBin))
    or (legacyPath and not path.isAbsolute(legacyPath))
  then
    system.fail("Setup requires absolute paths")
  end
  local header = marker .. table.concat(placeholders, "\n") .. "\n"
  if type(module) ~= "string" or module:sub(1, #header) ~= header then
    system.fail("Embedded Lua module must contain exactly four install placeholders in order after its marker")
  end
  for _, placeholder in ipairs(placeholders) do
    local first = module:find(placeholder, 1, true)
    if not first or module:find(placeholder, first + #placeholder, true) then
      system.fail("Embedded Lua module must contain exactly four install placeholders in order after its marker")
    end
  end
  local bin = managedBin or path.join(home, ".local", "bin", "rex-worktrees")
  local values = { rexBinDir, options.pathEnv, bin, path.dirname(configPath) }
  local installed = module
  for index, placeholder in ipairs(placeholders) do
    local pos = installed:find(placeholder, 1, true)
    local value = values[index] and literal(values[index]) or "false"
    installed = installed:sub(1, pos - 1) .. placeholder:sub(1, -6) .. value .. installed:sub(pos + #placeholder)
  end
  local luaPath = path.join(path.dirname(configPath), "rex-worktrees.lua")
  local binaryInfo = not managedBin and info(bin) or nil
  local luaInfo = info(luaPath)
  if binaryInfo and binaryInfo.type ~= "File" then system.fail("Refusing to replace non-file binary: " .. bin) end
  if luaInfo and luaInfo.type ~= "File" then system.fail("Refusing to replace non-file Lua module: " .. luaPath) end
  if luaInfo and fs.readFileString(luaPath):sub(1, #marker) ~= marker then
    system.fail("Refusing to replace unrelated Lua module: " .. luaPath)
  end
  local initInfo = info(configPath)
  if initInfo and initInfo.type ~= "File" and initInfo.type ~= "SymbolicLink" then
    system.fail("Rex init is not a file: " .. configPath)
  end
  if initInfo and initInfo.type == "SymbolicLink" and options.allowLinkedConfig == false then
    system.fail("Refusing linked Rex init: " .. configPath)
  end
  local current = initInfo and fs.readFileString(configPath) or ""
  local start = current:find(begin, 1, true)
  local finish = current:find(ending, 1, true)
  if
    (start == nil) ~= (finish == nil)
    or (
      start
      and (
        current:find(begin, start + #begin, true)
        or current:find(ending, finish + #ending, true)
        or finish <= start
        or (start > 1 and current:sub(start - 1, start - 1) ~= "\n")
      )
    )
  then
    system.fail("Malformed rex-worktrees registration in " .. configPath)
  end
  local existing = start and current:sub(start, finish + #ending - 1) or nil
  if existing and existing ~= manual and not managed(existing) and not hasSetup(existing) then
    system.fail("Malformed rex-worktrees registration in " .. configPath)
  end
  local unmarked = not start and hasRequire(current)
  local simple = not unmarked and (not existing or existing == manual or managed(existing))
  local legacyInfo = legacyPath and info(legacyPath) or nil
  if legacyInfo and legacyInfo.type ~= "File" then system.fail("Refusing non-file legacy settings: " .. legacyPath) end
  if legacyInfo and not simple then
    system.fail(
      "Cannot merge legacy settings "
        .. legacyPath
        .. " with custom Rex registration in "
        .. configPath
        .. '. Move roots/projects/worktreeRoot into require("rex-worktrees").setup({...}) manually, back up and remove the legacy JSON file, then rerun setup.'
    )
  end
  local legacy = legacyInfo and contracts.decode("Config", fs.readFileString(legacyPath)) or nil
  local nextRegistration = simple and manual or existing or ""
  if legacy then
    local function expand(value)
      if value == "~" then return home end
      if value:sub(1, 2) == "~/" then return path.join(home, value:sub(3)) end
      return path.resolve(path.dirname(legacyPath), value)
    end
    local settings = {}
    if legacy.roots and #legacy.roots > 0 then
      local roots = {}
      for _, root in ipairs(legacy.roots) do
        roots[#roots + 1] = literal(expand(root))
      end
      settings[#settings + 1] = "roots = { " .. table.concat(roots, ", ") .. " }"
    end
    if legacy.projects and #legacy.projects > 0 then
      local projects = {}
      for _, project in ipairs(legacy.projects) do
        if type(project) == "string" then
          projects[#projects + 1] = literal(expand(project))
        else
          local entry = "{ path = " .. literal(expand(project.path))
          if project.worktreeRoot then entry = entry .. ", worktreeRoot = " .. literal(expand(project.worktreeRoot)) end
          projects[#projects + 1] = entry .. " }"
        end
      end
      settings[#settings + 1] = "projects = { " .. table.concat(projects, ", ") .. " }"
    end
    if legacy.worktreeRoot then settings[#settings + 1] = "worktreeRoot = " .. literal(expand(legacy.worktreeRoot)) end
    nextRegistration = begin .. 'require("rex-worktrees").setup({' .. table.concat(settings, ", ") .. " })\n" .. ending
  end
  local backup = legacyPath and legacyPath .. ".backup" or nil
  local backupInfo = backup and info(backup) or nil
  if backupInfo and backupInfo.type ~= "File" then system.fail("Refusing non-file legacy backup: " .. backup) end
  local sourceInfo = fs.stat(source)
  if sourceInfo.type ~= "File" then system.fail("Installer source is not a file: " .. source) end
  if managedBin then
    if not info(managedBin) then system.fail("Managed binary does not exist: " .. managedBin) end
    local target = fs.stat(managedBin)
    if target.type ~= "File" or target.mode & 73 == 0 then
      system.fail("Managed binary must be an executable file: " .. managedBin)
    end
    if fs.realPath(managedBin) ~= fs.realPath(source) then
      system.fail("Managed binary must resolve to the running executable: " .. managedBin)
    end
  end
  local legacyDir = legacyPath and path.dirname(legacyPath) or nil
  local legacyDirInfo = legacyDir and info(legacyDir) or nil
  if legacyDirInfo and legacyDirInfo.type ~= "Directory" then
    system.fail("Refusing non-directory legacy settings path: " .. legacyDir)
  end
  if not managedBin then fs.makeDirectory(path.dirname(bin), { recursive = true }) end
  fs.makeDirectory(path.dirname(luaPath), { recursive = true })
  if not managedBin then
    if source ~= bin then
      atomic(bin, function(temporary)
        fs.copyFile(source, temporary)
        fs.chmod(temporary, 493)
      end)
    else
      fs.chmod(bin, 493)
    end
  end
  atomic(luaPath, function(temporary) fs.writeFileString(temporary, installed, { flag = "wx", mode = 420 }) end)
  if not start and not unmarked then
    fs.writeFileString(
      configPath,
      (current ~= "" and current:sub(-1) ~= "\n" and "\n" or "") .. nextRegistration,
      { flag = "a" }
    )
  elseif start and existing ~= nextRegistration then
    fs.writeFileString(configPath, current:sub(1, start - 1) .. nextRegistration .. current:sub(finish + #ending))
  end
  if backupInfo then fs.remove(backup) end
  if legacyInfo then fs.remove(legacyPath) end
  if legacyDirInfo then
    local ok, err = system.try(function() fs.remove(legacyDir) end)
    if not ok and err.code ~= "ENOTEMPTY" and err.code ~= "EEXIST" then error(err, 0) end
  end
  return { bin = bin, luaPath = luaPath, configPath = configPath, migrated = legacy ~= nil }
end

local function setup(managedBin, configPath)
  local home = system.getenv("HOME")
  if not home or home == "" then system.fail("HOME is required") end
  if configPath and not path.isAbsolute(configPath) then
    system.fail("--config must be an absolute path: " .. configPath)
  end
  local function executable(dir)
    local ok, value = system.try(function() return fs.stat(path.join(dir, "rex")) end)
    if not ok then
      if system.missing(value) then return false end
      error(value, 0)
    end
    return value.type == "File" and value.mode & 73 ~= 0
  end
  local rexBinDir = system.getenv("REX_BIN_DIR")
  if rexBinDir and rexBinDir ~= "" then
    if not path.isAbsolute(rexBinDir) or not executable(rexBinDir) then
      system.fail("REX_BIN_DIR must be an absolute directory containing an executable rex: " .. rexBinDir)
    end
  else
    rexBinDir = nil
    for entry in (system.getenv("PATH") or ""):gmatch("[^:]+") do
      if executable(entry) then
        rexBinDir = path.resolve(entry)
        break
      end
    end
  end
  if not rexBinDir then system.fail("Rex CLI not found: set REX_BIN_DIR or add an executable rex to PATH") end
  local target = configPath
  if not target then
    local checked = contracts.decode("RexConfigCheck", require("rex").rex({ "config", "check", "--json" }))
    if #checked.diagnostics > 0 then system.fail("Rex config has diagnostics; fix it before setup") end
    target = checked.path
  end
  local legacyPath = not configPath
      and path.join(system.getenv("XDG_CONFIG_HOME") or path.join(home, ".config"), "rex-worktrees", "config.json")
    or nil
  return installSetup({
    source = system.executable(),
    home = home,
    configPath = target,
    lua = require("assets").plugin,
    rexBinDir = rexBinDir,
    managedBin = managedBin,
    pathEnv = system.getenv("PATH"),
    legacyConfigPath = legacyPath,
    allowLinkedConfig = configPath == nil,
  })
end

return { installSetup = installSetup, setup = setup }
