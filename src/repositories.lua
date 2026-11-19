local system = require("runtime")
local fs, path = system.fs, system.path
local git, jj = require("git"), require("jj")
local M = {}
local function optional(fn)
  local ok, value = system.try(fn)
  if ok then return value end
  if system.missing(value) then return nil end
  error(value, 0)
end
local function backend(input)
  local canonical = fs.realPath(input)
  local current = fs.stat(canonical).type == "Directory" and canonical or path.dirname(canonical)
  while true do
    if optional(function() return fs.lstat(path.join(current, ".jj")) end) then return jj end
    if optional(function() return fs.lstat(path.join(current, ".git")) end) then return git end
    local parent = path.dirname(current)
    if parent == current then return git end
    current = parent
  end
end
function M.repository(input) return backend(input).repository(input) end
function M.project(input) return backend(input).project(input) end
function M.discoverProjects(roots, explicitProjects, contextPath, resolvedContext)
  local candidates, added = {}, {}
  local function add(candidate)
    if candidate and not added[candidate] then
      added[candidate] = true
      candidates[#candidates + 1] = candidate
    end
  end
  add(contextPath)
  for _, project in ipairs(explicitProjects) do
    add(project)
  end
  local function scan(directory, depth)
    local names = fs.readDirectory(directory)
    local marker = false
    for _, name in ipairs(names) do
      if name == ".git" or name == ".jj" then
        marker = true
        break
      end
    end
    if marker then add(directory) end
    if depth == 2 then return end
    for _, name in ipairs(names) do
      if name ~= ".git" and name ~= ".jj" then
        local child = path.join(directory, name)
        local entry = optional(function() return fs.stat(child) end)
        if entry and entry.type == "Directory" then scan(child, depth + 1) end
      end
    end
  end
  for _, root in ipairs(roots) do
    local info = optional(function() return fs.stat(root) end)
    if info then
      add(root)
      if info.type == "Directory" then scan(root, 0) end
    end
  end
  local found, seen = system.json.array(), {}
  for _, candidate in ipairs(candidates) do
    local ok, result = system.try(function()
      if resolvedContext and candidate == contextPath then
        return (resolvedContext.vcs == "jj" and jj or git).project(candidate, resolvedContext)
      end
      return M.project(candidate)
    end)
    if not ok then
      if not system.missing(result) and not git.notRepository(result) then error(result, 0) end
    else
      local key = result.vcs .. "\0" .. result.commonDir
      if not seen[key] then
        seen[key] = true
        found[#found + 1] = result
      end
    end
  end
  return found
end
return M
