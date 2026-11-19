local system = require("runtime")
local fs, path = system.fs, system.path
local M = {}
local function trim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
local function isolatedEnv()
  local env = {}
  for k, v in pairs(system.environment()) do
    if not k:match("^GIT_") then env[k] = v end
  end
  env.LC_ALL = "C"
  return env
end
local function jj(repo, ...)
  return system.run("jj", { "-R", repo, "--no-pager", "--color=never", ... }, nil, isolatedEnv())
end
local function inventory(repo, ...) return jj(repo, "--ignore-working-copy", "--at-op=@", ...) end
local function optional(fn, predicate)
  local ok, value = system.try(fn)
  if ok then return value end
  if predicate(value) then return nil end
  error(value, 0)
end
local function checkVersion()
  for _, tool in ipairs({ { "jj", 0, 46 }, { "git", 2, 42 } }) do
    local ok, output = system.try(function() return system.run(tool[1], { "--version" }, nil, isolatedEnv()) end)
    if not ok then
      if system.missing(output) then
        system.fail(
          ("%s executable not found on this Rex host; install %s >= %d.%d and ensure it is on the popup/task PATH"):format(
            tool[1],
            tool[1],
            tool[2],
            tool[3]
          )
        )
      end
      error(output, 0)
    end
    local major, minor = output:match("(%d+)%.(%d+)")
    major, minor = tonumber(major), tonumber(minor)
    if not major or major < tool[2] or (major == tool[2] and minor < tool[3]) then
      system.fail(("Requires %s >= %d.%d"):format(tool[1], tool[2], tool[3]))
    end
  end
end
local workspaceTemplate =
  'json({"name" => name, "path" => root, "commitId" => self.target().commit_id(), "changeId" => self.target().change_id()}) ++ "\\n"'
local revisionTemplate =
  'json({"commitId" => commit_id, "changeId" => change_id, "description" => description, "conflict" => self.conflict()}) ++ "\\n"'
local bookmarkTemplate =
  'json({"name" => name, "remote" => remote, "present" => present, "conflict" => conflict, "target" => try(self.normal_target().commit_id(), "")}) ++ "\\n"'
local function rows(raw, kind)
  local out = {}
  for line in raw:gmatch("[^\n]+") do
    local item = system.json.decode(line)
    if type(item) ~= "table" then system.fail("Invalid JJ " .. kind .. " output") end
    if kind == "workspace" then
      if
        type(item.name) ~= "string"
        or (not system.isNull(item.path) and type(item.path) ~= "string")
        or type(item.commitId) ~= "string"
        or type(item.changeId) ~= "string"
      then
        system.fail("Invalid JJ workspace output")
      end
    elseif kind == "revision" then
      if
        type(item.commitId) ~= "string"
        or type(item.changeId) ~= "string"
        or type(item.description) ~= "string"
        or type(item.conflict) ~= "boolean"
      then
        system.fail("Invalid JJ revision output")
      end
    elseif
      type(item.name) ~= "string"
      or (not system.isNull(item.remote) and type(item.remote) ~= "string")
      or type(item.present) ~= "boolean"
      or type(item.conflict) ~= "boolean"
      or type(item.target) ~= "string"
    then
      system.fail("Invalid JJ bookmark output")
    end
    out[#out + 1] = item
  end
  return out
end
local function pin(id) return type(id) == "string" and #id >= 40 and #id <= 64 and id:match("^[0-9a-f]+$") ~= nil end
local function validName(value)
  if
    type(value) ~= "string"
    or trim(value) == ""
    or trim(value) ~= value
    or value:sub(1, 1) == "-"
    or value:find("[\\/%z\1-\31\127]")
    or value:find("\194[\128-\159]")
    or value == "."
    or value == ".."
  then
    system.fail("Invalid JJ workspace name")
  end
  return value
end
local function validPin(value)
  if not pin(value) then system.fail("Invalid full JJ base commit ID") end
  return value
end
local function metadata(dot)
  local pointer = path.join(dot, "repo")
  local entry = optional(function() return fs.stat(pointer) end, system.missing)
  if not entry then system.fail("JJ workspace has no repository metadata") end
  if entry.type == "Directory" then return fs.realPath(pointer) end
  if entry.type ~= "File" then system.fail("Invalid JJ repository pointer") end
  local text = trim(fs.readFileString(pointer))
  if text == "" or text:find("\0", 1, true) then system.fail("Invalid JJ repository pointer") end
  local target = fs.realPath(path.resolve(dot, text))
  if fs.stat(target).type ~= "Directory" then system.fail("Invalid JJ repository pointer") end
  return target
end
function M.repository(input)
  checkVersion()
  local directory = fs.realPath(input)
  if fs.stat(directory).type ~= "Directory" then directory = path.dirname(directory) end
  while true do
    local dot = path.join(directory, ".jj")
    local info = optional(function() return fs.stat(dot) end, system.missing)
    if info then
      if info.type ~= "Directory" then system.fail("Invalid JJ workspace metadata") end
      return { vcs = "jj", path = directory, commonDir = metadata(dot), name = path.basename(directory) }
    end
    local parent = path.dirname(directory)
    if parent == directory then system.fail("Not a JJ repository") end
    directory = parent
  end
end
function M.listWorkspaces(repo, resolved)
  local current = resolved or M.repository(repo)
  local parsed = rows(inventory(current.path, "workspace", "list", "-T", workspaceTemplate), "workspace")
  local out = system.json.array()
  for _, item in ipairs(parsed) do
    local location, present
    if system.isNull(item.path) then
      location, present = system.json.null, false
    else
      location = path.resolve(item.path)
      local real = optional(function() return fs.realPath(location) end, system.missing)
      present = false
      if real then
        location = real
        local dot = optional(function() return fs.stat(path.join(real, ".jj")) end, system.missing)
        if dot and dot.type == "Directory" then present = metadata(path.join(real, ".jj")) == current.commonDir end
      end
    end
    out[#out + 1] = {
      vcs = "jj",
      path = location,
      name = item.name,
      head = item.commitId,
      changeId = item.changeId,
      present = present,
    }
  end
  return out
end
function M.project(input, resolved, workspaces)
  local current = resolved or M.repository(input)
  local primary = path.dirname(path.dirname(current.commonDir))
  for _, item in ipairs(workspaces or M.listWorkspaces(current.path, current)) do
    if item.path == primary and item.present then
      return { vcs = "jj", path = fs.realPath(primary), commonDir = current.commonDir, name = path.basename(primary) }
    end
  end
  return current
end
function M.resolveRevision(repo, expression, resolved)
  if
    type(expression) ~= "string"
    or trim(expression) == ""
    or expression:sub(1, 1) == "-"
    or expression:find("[%z\1-\31\127]")
    or expression:find("\194[\128-\159]")
  then
    system.fail("Invalid JJ base revision")
  end
  local current = resolved or M.repository(repo)
  local revset = pin(expression) and ('commit_id("' .. expression .. '")') or expression
  local parsed =
    rows(inventory(current.path, "log", "-r", revset, "--no-graph", "--limit", "2", "-T", revisionTemplate), "revision")
  if #parsed ~= 1 or parsed[1].conflict then system.fail("JJ base must resolve to one non-conflicted revision") end
  local item = parsed[1]
  return { commitId = item.commitId, changeId = item.changeId, description = item.description }
end
local function listRevisions(current, bookmarks)
  bookmarks = bookmarks or rows(inventory(current.path, "bookmark", "list", "-T", bookmarkTemplate), "bookmark")
  local ok, mainline = system.try(
    function()
      return inventory(current.path, "log", "-r", "trunk()", "--no-graph", "--limit", "2", "-T", revisionTemplate)
    end
  )
  if not ok then
    local stderr = type(mainline) == "table" and mainline.program == "jj" and (mainline.stderr or "") or ""
    local text = stderr:lower()
    if
      text:match("^error: failed to parse revset")
      or text:match("^error: failed to resolve revset")
      or text:match("^error: invalid revset")
      or text:match("^error: revision ")
      or text:match("^error: revset ")
      or text:match("^error: cannot resolve ")
      or text:match("^error: no such revision")
    then
      mainline = ""
    else
      error(mainline, 0)
    end
  end
  local choices, seen = system.json.array(), {}
  local function add(item, expression, label)
    local revision = { commitId = item.commitId, changeId = item.changeId, description = item.description }
    choices[#choices + 1] = {
      expression = expression,
      label = label
        .. " · "
        .. (trim(item.description) ~= "" and trim(item.description) or item.changeId:sub(1, 12))
        .. " · "
        .. item.commitId:sub(1, 12),
      revision = revision,
    }
    seen[item.commitId] = true
  end
  local main = rows(mainline, "revision")
  if #main == 1 and not main[1].conflict and not main[1].commitId:match("^0+$") then
    add(main[1], "trunk()", "Mainline")
  end
  for _, expression in ipairs({ "@-", "bookmarks()", "remote_bookmarks()" }) do
    for _, item in
      ipairs(
        rows(
          inventory(current.path, "log", "-r", expression, "--no-graph", "--limit", "40", "-T", revisionTemplate),
          "revision"
        )
      )
    do
      if not item.conflict and not seen[item.commitId] then
        local label = expression == "@-" and "Parent" or expression == "bookmarks()" and "Bookmark" or "Remote bookmark"
        for _, ref in ipairs(bookmarks) do
          local remote = not system.isNull(ref.remote)
          if
            ref.present
            and not ref.conflict
            and pin(ref.target)
            and ref.target == item.commitId
            and remote == (expression == "remote_bookmarks()")
          then
            if expression ~= "@-" then label = ref.name .. (remote and ("@" .. ref.remote) or "") end
            break
          end
        end
        add(item, item.commitId, label)
      end
    end
  end
  return choices
end
function M.listRevisions(repo, resolved) return listRevisions(resolved or M.repository(repo)) end
local function gitRoot(repo)
  local raw = trim(inventory(repo, "git", "root"))
  if raw == "" then system.fail("JJ backing Git directory is unavailable") end
  return fs.realPath(raw)
end
function M.cloneSource(repo, host, resolved, includeInventory)
  local current = resolved or M.repository(repo)
  local ok, raw = system.try(
    function()
      return system.run(
        "git",
        { "--git-dir", gitRoot(current.path), "config", "--get", "remote.origin.url" },
        nil,
        isolatedEnv()
      )
    end
  )
  if not ok then system.fail("JJ repository has no usable origin URL") end
  local valid, url = system.try(
    function() return require("git").safeOrigin(raw:gsub("\n$", ""), true, current.path) end
  )
  if not valid then system.fail("JJ origin URL is unsafe or local to another Rex host") end
  local source = { vcs = "jj", url = url, sourceHostId = host }
  if includeInventory == false then return source end
  local bookmarks = rows(inventory(current.path, "bookmark", "list", "-T", bookmarkTemplate), "bookmark")
  source.revisions = listRevisions(current, bookmarks)
  local remote = {}
  for _, item in ipairs(bookmarks) do
    if item.present and not item.conflict and item.remote == "origin" then remote[#remote + 1] = item end
  end
  if #remote == 1 then
    for _, choice in ipairs(source.revisions) do
      if choice.revision.commitId == remote[1].target then
        source.revision = choice.revision
        break
      end
    end
  end
  return source
end
function M.planWorkspace(repo, name, revision, root, resolved, workspaces)
  validName(name)
  local source = resolved or M.repository(repo)
  local trees = workspaces or M.listWorkspaces(source.path, source)
  local primary = M.project(source.path, source, trees)
  local paths = {}
  for _, item in ipairs(trees) do
    if item.name == name then
      system.fail(("JJ workspace %s already registered; inspect it before retrying"):format(name))
    end
    if not system.isNull(item.path) then paths[#paths + 1] = item.path end
  end
  local base = M.resolveRevision(source.path, revision, source)
  local destination =
    require("checkout").planCheckoutPath(primary.path, { primary.commonDir, gitRoot(primary.path) }, paths, name, root)
  return { repository = source, path = destination, workspaceName = name, base = base }
end
function M.createWorkspace(repo, name, base, root)
  local id = validPin(base.commitId)
  local planned = M.planWorkspace(repo, name, id, root)
  if planned.base.changeId ~= base.changeId or planned.base.commitId ~= id then
    system.fail("JJ base changed since review; inspect before retrying")
  end
  fs.makeDirectory(path.dirname(planned.path), { recursive = true })
  if fs.realPath(path.dirname(planned.path)) ~= path.dirname(planned.path) then
    system.fail("Symlinked JJ workspace parent")
  end
  jj(planned.repository.path, "workspace", "add", "--name", name, "-r", 'commit_id("' .. id .. '")', planned.path)
  for _, item in ipairs(M.listWorkspaces(planned.repository.path, planned.repository)) do
    if item.name == name and item.path == planned.path and item.present then return item end
  end
  system.fail("JJ did not list created workspace at " .. planned.path .. "; inspect before retrying")
end
function M.newChange(repo, base)
  local id = validPin(base.commitId)
  local current = M.repository(repo)
  local resolved = M.resolveRevision(current.path, id, current)
  if resolved.changeId ~= base.changeId then
    system.fail("Selected JJ base is unavailable in destination clone; clone retained")
  end
  local before
  for _, item in ipairs(M.listWorkspaces(current.path, current)) do
    if item.path == current.path then
      before = item
      break
    end
  end
  if not before or not before.present then system.fail("Cloned JJ default workspace is unavailable") end
  jj(current.path, "new", "-r", 'commit_id("' .. id .. '")')
  for _, item in ipairs(M.listWorkspaces(current.path, current)) do
    if item.name == before.name and item.present then return item end
  end
  system.fail("JJ did not list cloned default workspace after new change")
end
function M.cloneRepository(url, destination)
  checkVersion()
  local valid, safe = system.try(function() return require("git").safeOrigin(url, true) end)
  if not valid then system.fail("Unsafe JJ clone URL") end
  local ok, result = system.try(
    function()
      return system.capture({ "jj", "git", "clone", safe, destination }, { env = isolatedEnv(), inherit = true })
    end
  )
  if not ok then system.fail("Unable to launch JJ clone; destination may need inspection") end
  if not result.ok then
    system.fail(("JJ clone failed (exit %s); destination retained at %s"):format(result.code, destination))
  end
end
return M
