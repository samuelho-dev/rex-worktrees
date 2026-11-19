local system = require("runtime")
local contracts = require("contracts")
local path = system.path

local function loadConfig()
  local raw = system.getenv("REX_WORKTREES_CONFIG")
  local envelope
  if raw then
    envelope = contracts.decode("ConfigEnvelope", raw)
  else
    local ok, response = system.try(function() return require("rex").rex({ "do", "worktrees_config", "--json" }) end)
    if not ok then
      system.fail(
        "Native Rex worktrees_config is unavailable; register rex-worktrees.setup in this machine's Rex config and reload it"
      )
    end
    if type(response) == "string" then response = system.json.decode(response) end
    if type(response) == "string" then response = system.json.decode(response) end
    envelope = contracts.validate("ConfigEnvelope", response)
  end
  local directory, values = envelope.directory, envelope.config
  if not path.isAbsolute(directory) or directory:find("\0", 1, true) then
    system.fail("Native Rex config directory must be an absolute path")
  end
  local home = system.getenv("HOME")
  if not home or not path.isAbsolute(home) then system.fail("HOME must be an absolute directory") end
  local function expand(value)
    if value == "~" then
      value = home
    elseif value:sub(1, 2) == "~/" then
      value = path.join(home, value:sub(3))
    end
    return path.resolve(directory, value)
  end
  local result = { roots = system.json.array(), projects = system.json.array(), projectRoots = system.json.array() }
  for _, root in ipairs(values.roots or {}) do
    result.roots[#result.roots + 1] = expand(root)
  end
  for _, entry in ipairs(values.projects or {}) do
    local project = type(entry) == "string" and entry or entry.path
    result.projects[#result.projects + 1] = expand(project)
    if type(entry) == "table" and entry.worktreeRoot then
      result.projectRoots[#result.projectRoots + 1] =
        { path = expand(project), worktreeRoot = expand(entry.worktreeRoot) }
    end
  end
  if values.worktreeRoot then result.worktreeRoot = expand(values.worktreeRoot) end
  return result
end

local function resolveCloneRoot(roots, projects, stateRoot)
  if roots[1] then return roots[1] end
  local remembered = require("state").rememberedCloneRoot(stateRoot)
  if remembered then return remembered end
  local parent
  for _, project in ipairs(projects) do
    local candidate = path.dirname(project.path)
    if parent and parent ~= candidate then
      parent = nil
      break
    end
    parent = candidate
  end
  if parent then return parent end
  local home = system.getenv("HOME")
  if not home or not path.isAbsolute(home) then system.fail("Target HOME must be an absolute directory") end
  return home
end

local function resolveWorktreeRoot(repoPath)
  local config = loadConfig()
  local repositories, git = require("repositories"), require("git")
  local target = repositories.project(repoPath)
  for _, entry in ipairs(config.projectRoots) do
    local ok, candidate = system.try(function() return repositories.repository(entry.path) end)
    if not ok and not git.missing(candidate) and not git.notRepository(candidate) then error(candidate, 0) end
    if ok and candidate and candidate.vcs == target.vcs and candidate.commonDir == target.commonDir then
      return entry.worktreeRoot
    end
  end
  if config.worktreeRoot then return path.join(config.worktreeRoot, target.name) end
end

return { loadConfig = loadConfig, resolveCloneRoot = resolveCloneRoot, resolveWorktreeRoot = resolveWorktreeRoot }
