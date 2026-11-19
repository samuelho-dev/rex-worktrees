local system = require("runtime")
local fs, path = system.fs, system.path
local M = {}
local function trim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
local function env()
  local result = {}
  for k, v in pairs(system.environment()) do
    if not k:match("^GIT_") then result[k] = v end
  end
  result.LC_ALL = "C"
  return result
end
local function git(cwd, ...) return system.run("git", { "-C", cwd, ... }, nil, env()) end
local function optional(fn, predicate)
  local ok, value = system.try(fn)
  if ok then return value end
  if predicate(value) then return nil end
  error(value, 0)
end
M.missing = system.missing
function M.notRepository(e)
  if type(e) ~= "table" or e.program ~= "git" or type(e.args) ~= "table" then return false end
  local found = false
  for _, arg in ipairs(e.args) do
    if arg == "rev-parse" then found = true end
  end
  local stderr = e.stderr or ""
  return found
    and (
      stderr:match("^fatal: not a git repository") ~= nil
      or stderr:match("^fatal: this operation must be run in a work tree") ~= nil
    )
end
function M.gitContext(directory)
  local out = optional(function() return git(directory, "rev-parse", "--absolute-git-dir") end, M.notRepository)
  return out and trim(out)
end
function M.safeOrigin(raw, sameHost, base)
  local function unsafe() system.fail("Unsafe origin URL") end
  if
    type(raw) ~= "string"
    or raw == ""
    or raw:sub(1, 1) == "-"
    or raw:find("[%z\1-\31\127]")
    or raw:match("^[%a][%w+%.%-]*::")
  then
    unsafe()
  end
  if raw:sub(1, 1) == "/" or raw:sub(1, 2) == "./" or raw:sub(1, 3) == "../" or raw:sub(1, 7) == "file://" then
    if not sameHost then system.fail("Local source origins require the same Rex host") end
    if raw:sub(1, 7) == "file://" then
      local value = raw:sub(8)
      if value:sub(1, 1) ~= "/" or value:find("[?#]") or value:gsub("%%(%x%x)", ""):find("%%") then unsafe() end
      value = value:gsub("%%(%x%x)", function(hex) return string.char(tonumber(hex, 16)) end)
      if value:find("[%z\1-\31\127]") then unsafe() end
      return value
    end
    if raw:sub(1, 1) ~= "/" and not base then unsafe() end
    return raw:sub(1, 1) == "/" and raw or path.resolve(base, raw)
  end
  if raw:find("%s") then unsafe() end
  local scheme, authority, rest = raw:match("^([%a][%w+%.%-]*)://([^/]+)(/.*)$")
  if scheme then
    scheme = scheme:lower()
    if scheme ~= "https" and scheme ~= "ssh" and scheme ~= "git" or rest:find("[?#]") then unsafe() end
    local user, host = authority:match("^(.-)@(.+)$")
    if user then
      if scheme ~= "ssh" or not user:match("^[%w_][%w_.%-]*$") then unsafe() end
    else
      host = authority
    end
    if not host or host == "" or host:find("@") then unsafe() end
    if host:sub(1, 1) == "[" then
      if not host:match("^%[[%x:%.]+%]:?%d*$") then unsafe() end
    elseif not host:match("^[%w%.%-]+:?%d*$") then
      unsafe()
    end
    return raw
  end
  if raw:match("^[%a][%w+%.%-]*://") then unsafe() end
  local authority2, remote = raw:match("^([^:]+):(.+)$")
  if authority2 and remote and remote:match("^[%w_./~+%%%-][%w_./~+%%:%-]*$") then
    local user, host = authority2:match("^(.-)@(.+)$")
    if not user then host = authority2 end
    if host:match("^[%w_.%-]+$") and (not user or user:match("^[%w_][%w_.%-]*$")) then return raw end
  end
  unsafe()
end
function M.origin(repoPath)
  local ok, raw = system.try(function() return git(repoPath, "config", "--get", "remote.origin.url") end)
  if not ok then system.fail("Repository has no usable origin URL") end
  local valid, result = system.try(function() return M.safeOrigin(raw:gsub("\n$", ""), true, repoPath) end)
  if not valid then system.fail("Repository origin URL is unsafe or local to another Rex host") end
  return result
end
function M.cloneSource(repoPath, host, resolved, includeInventory)
  local repo = resolved or M.repository(repoPath)
  local source = { vcs = "git", url = M.origin(repo.path), sourceHostId = host }
  if includeInventory == false then return source end
  local refs = git(repo.path, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin")
  local branches, seen = system.json.array(), {}
  for ref in refs:gmatch("[^\n]+") do
    local branch = ref:match("^refs/heads/(.+)$")
      or (ref ~= "refs/remotes/origin/HEAD" and ref:match("^refs/remotes/origin/(.+)$"))
    if branch and not seen[branch] then
      seen[branch] = true
      branches[#branches + 1] = branch
    end
  end
  source.branches = branches
  local ok, head = system.try(
    function() return git(repo.path, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD") end
  )
  local branch = ok and trim(head):gsub("^refs/remotes/origin/", "") or ""
  if branch == "" then branch = trim(git(repo.path, "branch", "--show-current")) end
  if branch ~= "" then source.branch = branch end
  return source
end
function M.remoteBranches(repoPath)
  local result = system.json.array()
  for ref in git(repoPath, "for-each-ref", "--format=%(refname)", "refs/remotes/origin"):gmatch("[^\n]+") do
    local branch = ref:match("^refs/remotes/origin/(.+)$")
    if branch and branch ~= "HEAD" then result[#result + 1] = branch end
  end
  return result
end
function M.remoteBranchHead(repoPath, branch)
  return trim(git(repoPath, "rev-parse", "--verify", "refs/remotes/origin/" .. branch .. "^{commit}"))
end
function M.originDefaultHead(repoPath)
  local ok, ref = system.try(function() return git(repoPath, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD") end)
  if not ok then system.fail("Cannot determine the existing repository's cached origin default branch") end
  return trim(git(repoPath, "rev-parse", "--verify", trim(ref) .. "^{commit}"))
end
function M.cloneRepository(url, destination, branch)
  local args = { "git", "clone", "--origin", "origin" }
  if branch then
    args[#args + 1] = "--branch"
    args[#args + 1] = branch
  end
  args[#args + 1] = "--"
  args[#args + 1] = url
  args[#args + 1] = destination
  local e = env()
  e.GIT_TERMINAL_PROMPT = "1"
  local result = system.capture(args, { env = e, inherit = true })
  if not result.ok then
    system.fail(("Git clone failed (exit %s); destination retained at %s"):format(result.code, destination))
  end
end
function M.createPrimaryBranch(repoPath, branch) git(repoPath, "switch", "-c", branch) end
local function invalidParts(value)
  if value == "" or value:sub(1, 1) == "/" or value:sub(-1) == "/" or value:find("//", 1, true) then return true end
  for part in value:gmatch("[^/]+") do
    if part == "." or part == ".." then return true end
  end
  return false
end
local function invalidName(name)
  return trim(name) == "" or name:find("[%z\1-\31\127]") or invalidParts(name:gsub("\\", "/"))
end
function M.validCloneBranch(branch, name)
  if not branch or branch:sub(1, 1) == "-" or branch:find("[%z\1-\31\127]") or invalidParts(branch) then
    system.fail("Invalid clone branch")
  end
  local ok = system.try(function() return system.run("git", { "check-ref-format", "--branch", branch }) end)
  if not ok then system.fail("Invalid clone branch") end
  if name ~= nil and (name:sub(1, 1) == "-" or invalidName(name)) then system.fail("Invalid worktree name") end
end
function M.listWorktrees(repoPath)
  local output = git(repoPath, "worktree", "list", "--porcelain", "-z")
  local records, record = system.json.array(), nil
  for field in (output .. "\0"):gmatch("(.-)\0") do
    if field == "" then
      if record then
        records[#records + 1] = record
        record = nil
      end
    elseif field:sub(1, 9) == "worktree " then
      record =
        { vcs = "git", path = field:sub(10), branch = system.json.null, head = "", bare = false, prunable = false }
    elseif record then
      if field:sub(1, 5) == "HEAD " then
        record.head = field:sub(6)
      elseif field:sub(1, 18) == "branch refs/heads/" then
        record.branch = field:sub(19)
      elseif field == "bare" then
        record.bare = true
      elseif field:sub(1, 8) == "prunable" then
        record.prunable = true
      end
    end
  end
  for _, item in ipairs(records) do
    item.path = optional(function() return fs.realPath(item.path) end, system.missing) or item.path
  end
  return records
end
function M.repository(input)
  local canonical = fs.realPath(input)
  local top = git(canonical, "rev-parse", "--show-toplevel"):gsub("\n$", "")
  local common = git(canonical, "rev-parse", "--path-format=absolute", "--git-common-dir"):gsub("\n$", "")
  return {
    vcs = "git",
    path = fs.realPath(top),
    commonDir = fs.realPath(path.resolve(canonical, common)),
    name = path.basename(top),
  }
end
function M.project(input, resolved, worktrees)
  local checkout = resolved or M.repository(input)
  local primary = (worktrees or M.listWorktrees(checkout.path))[1]
  if not primary or primary.path == checkout.path then return checkout end
  local main
  if not primary.bare then
    main = optional(
      function() return M.repository(primary.path) end,
      function(e) return system.missing(e) or M.notRepository(e) end
    )
  end
  if main and main.commonDir == checkout.commonDir then return main end
  return { vcs = checkout.vcs, path = checkout.path, commonDir = checkout.commonDir, name = path.basename(primary.path) }
end
function M.listBranches(repoPath)
  local result = system.json.array()
  for ref in git(repoPath, "for-each-ref", "--format=%(refname)%00", "refs/heads"):gmatch("([^\0]+)\0\n") do
    result[#result + 1] = ref:gsub("^refs/heads/", "")
  end
  return result
end
function M.repositoryHead(repoPath)
  local head = trim(git(repoPath, "rev-parse", "--verify", "HEAD"))
  local branch = trim(git(repoPath, "branch", "--show-current"))
  return { head = head, branch = branch ~= "" and branch or system.json.null }
end
function M.planWorktree(repoPath, branch, root, name, resolved, worktrees)
  if not branch or branch:sub(1, 1) == "-" or branch:find("\0", 1, true) or invalidParts(branch) then
    system.fail("Invalid branch name: " .. system.json.encode(branch))
  end
  git(repoPath, "check-ref-format", "--branch", branch)
  if name ~= nil and invalidName(name) then system.fail("Invalid worktree name: " .. system.json.encode(name)) end
  local repo = resolved or M.repository(repoPath)
  local trees = worktrees or M.listWorktrees(repo.path)
  local main
  for _, tree in ipairs(trees) do
    if tree.branch == branch then
      local marker = optional(function() return fs.stat(path.join(tree.path, ".git")) end, system.missing)
      if tree.prunable or not marker then
        system.fail(("Branch %s is assigned to an unavailable checkout: %s"):format(branch, tree.path))
      end
      return { repository = repo, path = tree.path, branch = branch, existing = true }
    end
    if not main and not tree.bare then main = tree end
  end
  if not main then system.fail("No main checkout exists") end
  local primary = main.path == repo.path and repo or M.repository(main.path)
  local paths = {}
  for _, tree in ipairs(trees) do
    paths[#paths + 1] = tree == main and primary.path or tree.path
  end
  return {
    repository = repo,
    path = require("checkout").planCheckoutPath(primary.path, { repo.commonDir }, paths, name or branch, root),
    branch = branch,
    existing = false,
  }
end
function M.createWorktree(repoPath, branch, options)
  options = options or {}
  local pin, attach = options.startPoint, options.attachOnly
  if pin and (not pin:match("^[0-9a-f]+$") or #pin < 40 or #pin > 64) then system.fail("Invalid pinned base commit") end
  local repo = M.repository(repoPath)
  local branches = M.listBranches(repo.path)
  local exists = false
  for _, item in ipairs(branches) do
    if item == branch then exists = true end
  end
  if pin and exists then system.fail(("Branch %s appeared after review; inspect before retrying"):format(branch)) end
  if attach and not exists then
    system.fail(("Branch %s disappeared after review; inspect before retrying"):format(branch))
  end
  local trees = M.listWorktrees(repo.path)
  local planned = M.planWorktree(repoPath, branch, options.worktreeRoot, options.worktreeName, repo, trees)
  if planned.existing then
    if pin or attach then
      system.fail(("Branch %s changed checkout after review; inspect before retrying"):format(branch))
    end
    for _, tree in ipairs(trees) do
      if tree.path == planned.path then return tree end
    end
    system.fail(("Worktree %s disappeared after review; inspect before retrying"):format(planned.path))
  end
  branches = M.listBranches(repo.path)
  exists = false
  for _, item in ipairs(branches) do
    if item == branch then exists = true end
  end
  if pin and exists then system.fail(("Branch %s appeared after review; inspect before retrying"):format(branch)) end
  if attach and not exists then
    system.fail(("Branch %s disappeared after review; inspect before retrying"):format(branch))
  end
  fs.makeDirectory(path.dirname(planned.path), { recursive = true })
  if fs.realPath(path.dirname(planned.path)) ~= path.dirname(planned.path) then
    system.fail("Symlinked worktree parent: " .. path.dirname(planned.path))
  end
  local args = { "worktree", "add" }
  if pin or (not exists and not attach) then
    args[#args + 1] = "-b"
    args[#args + 1] = branch
  end
  args[#args + 1] = "--"
  args[#args + 1] = planned.path
  if pin then
    args[#args + 1] = pin
  elseif exists or attach then
    args[#args + 1] = branch
  end
  git(repo.path, table.unpack(args))
  for _, tree in ipairs(M.listWorktrees(repo.path)) do
    if tree.path == planned.path then return tree end
  end
  system.fail("Git did not list created worktree " .. planned.path)
end
return M
