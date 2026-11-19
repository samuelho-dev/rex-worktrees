local system = require("runtime")
local contracts = require("contracts")
local config = require("config")
local git = require("git")
local jj = require("jj")
local repositories = require("repositories")
local rex = require("rex")
local M = {}
local function inventory(repo, worktrees)
  return {
    worktrees = worktrees or (repo.vcs == "git" and git.listWorktrees(repo.path) or jj.listWorkspaces(repo.path, repo)),
    branches = repo.vcs == "git" and git.listBranches(repo.path) or system.json.array(),
    revisions = repo.vcs == "jj" and jj.listRevisions(repo.path, repo) or system.json.array(),
    worktreeRoot = config.resolveWorktreeRoot(repo.path),
  }
end
local function merge(a, b)
  for key, value in pairs(b) do
    a[key] = value
  end
  return a
end
function M.dispatchHost(request, command)
  contracts.validate("Request", request)
  local host = rex.localHost()
  if host.id ~= request.hostId then
    system.fail("Wrong Rex host: expected " .. request.hostId .. ", got " .. host.id)
  end
  local kind = request.kind
  local paths = {}
  if kind == "discover" then
    if request.context and not system.isNull(request.context) then paths[1] = request.context end
  elseif kind == "project" then
    paths[1] = request.path
  elseif kind == "clone-plan" or kind == "clone-launch" then
    paths[1] = request.input.repo
  elseif kind == "plan" or kind == "launch" then
    paths[1] = request.input.repo
    if request.input.path and not system.isNull(request.input.path) then paths[2] = request.input.path end
  elseif kind ~= "sessions" then
    paths[1] = request.repo
  end
  for _, path in ipairs(paths) do
    if not system.path.isAbsolute(path) then
      system.fail("Destination repository and worktree paths must be absolute")
    end
  end
  local result = { version = 5, hostId = host.id, kind = kind }
  if kind == "sessions" then
    result.sessions, result.clients = rex.listSessions(), rex.listClients()
  elseif kind == "discover" then
    local cfg = config.loadConfig()
    if request.context and not system.isNull(request.context) then
      local ok, value = system.try(function() return repositories.repository(request.context) end)
      if ok then
        result.checkout = value
      elseif not git.missing(value) and not git.notRepository(value) then
        error(value, 0)
      end
    end
    result.sessions, result.clients = rex.listSessions(), rex.listClients()
    result.projects = repositories.discoverProjects(
      cfg.roots,
      cfg.projects,
      not system.isNull(request.context) and request.context or nil,
      result.checkout
    )
    result.roots = cfg.roots
    result.cloneRoot = config.resolveCloneRoot(cfg.roots, result.projects)
  elseif kind == "project" then
    local ok, value = system.try(function() return system.fs.stat(request.path) end)
    if not ok then
      if system.missing(value) then
        result.kind, result.path = "project-missing", request.path
        return result
      end
      error(value, 0)
    end
    result.checkout = repositories.repository(request.path)
    local repo = result.checkout
    local worktrees = repo.vcs == "git" and git.listWorktrees(repo.path) or jj.listWorkspaces(repo.path, repo)
    result.project = repo.vcs == "git" and git.project(request.path, repo, worktrees)
      or jj.project(request.path, repo, worktrees)
    merge(result, inventory(result.project, worktrees))
  elseif kind == "clone-source" then
    local repo = repositories.repository(request.repo)
    result.source = repo.vcs == "git" and git.cloneSource(repo.path, host.id, repo)
      or jj.cloneSource(repo.path, host.id, repo)
  elseif kind == "worktrees" then
    result.repository = repositories.repository(request.repo)
    merge(result, inventory(result.repository))
  elseif kind == "revision" then
    local repo = repositories.repository(request.repo)
    if repo.vcs ~= "jj" then system.fail("Base revision requires a JJ repository") end
    result.revision = jj.resolveRevision(repo.path, request.revision, repo)
  elseif kind == "plan" then
    result.plan = require("worktrees").planLaunch(request.input, host.id)
  elseif kind == "clone-plan" then
    result.plan = require("worktrees").planClone(request.input, host.id)
  elseif kind == "launch" then
    result.result = require("worktrees").launch(request.input, command, request.reviewed, host.id)
  elseif kind == "clone-launch" then
    result.result = require("worktrees").launchClone(request.input, command, request.reviewed, host.id)
  else
    system.fail("Unknown host request kind")
  end
  return result
end
local dispatchHost = M.dispatchHost
function M.dispatchHost(request, command)
  return rex.withOperation(function() return dispatchHost(request, command) end)
end
function M.hostRequest(raw, command) return M.dispatchHost(contracts.decode("Request", raw), command) end
return M
