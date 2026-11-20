local system = require("runtime")
local contracts = require("contracts")
local git = require("git")
local jj = require("jj")
local repositories = require("repositories")
local config = require("config")
local state = require("state")
local rex = require("rex")
local fs, path = system.fs, system.path
local M = {}

local function find(items, predicate)
  for _, item in ipairs(items) do
    if predicate(item) then return item end
  end
end
local function contains(items, value)
  return find(items, function(item) return item == value end) ~= nil
end
local function copy(t)
  local result = {}
  for k, v in pairs(t) do
    result[k] = v
  end
  return result
end
local function join(a, b, separator)
  if not a or a == "" then return b end
  if not b or b == "" then return a end
  return a .. separator .. b
end
local function sameSession(a, b)
  return a.kind == b.kind and (a.kind == "existing" and a.id == b.id or a.kind == "new" and a.name == b.name)
end
local function sameRevision(a, b)
  return (not a and not b) or not not (a and b and a.commitId == b.commitId and a.changeId == b.changeId)
end
local function validName(name, role)
  if not name or not name:match("%S") or name:sub(1, 1) == "-" or name:find("[%z\1-\31\127]") then
    system.fail("Invalid Rex " .. role .. " name")
  end
end
local function normalizedDirectory(value, message)
  if not path.isAbsolute(value) or path.resolve(value) ~= value or value == path.parse(value).root then
    system.fail(message)
  end
end
local function liveBlock(sessionId, blockId, destination)
  local function call(method, schema)
    local ok, raw = system.try(
      function() return rex.rex({ "block", "call", "-s", sessionId, "-b", blockId, method }) end
    )
    if not ok then
      local diagnostic = ((raw.stderr or ""):match("^%s*(.-)%s*$") or "")
      if diagnostic == "" then diagnostic = (raw.stdout or ""):match("^%s*(.-)%s*$") end
      if
        raw.exitCode == 3
        and (
          diagnostic == 'Error: block target "' .. blockId .. '" not found'
          or diagnostic
            == 'Error: block target "' .. blockId .. '" not found: session scope: session "' .. sessionId .. '" not found'
        )
      then
        return nil
      end
      error(raw, 0)
    end
    return contracts.decode(schema, raw)
  end
  local process = call("process", "RexProcess")
  if
    not process
    or (process.last_exit and process.last_exit ~= system.json.null)
    or not process.foreground
    or process.foreground == system.json.null
  then
    return false
  end
  local directory = process.foreground.cwd
  if type(directory) ~= "string" or not path.isAbsolute(directory) or directory:find("\0", 1, true) then return false end
  local ok, result = system.try(function() return fs.realPath(directory) end)
  if not ok then
    if system.missing(result) then return false end
    error(result, 0)
  end
  return result == destination
end

function M.planLaunch(input, expectedHostId)
  local host = rex.localHost()
  if expectedHostId and host.id ~= expectedHostId then
    system.fail("Wrong Rex host: expected " .. expectedHostId .. ", got " .. host.id)
  end
  contracts.validate("SessionSelection", input.session)
  if
    input.session.kind == "existing"
    and not find(rex.listSessions(), function(item) return item.id == input.session.id end)
  then
    system.fail("Rex session " .. input.session.id .. " does not exist locally")
  end
  local clients = rex.listClients()
  if input.clientId and not find(clients, function(item) return item.id == input.clientId end) then
    system.fail("Rex app client " .. input.clientId .. " is not connected locally")
  end
  local clientId = input.clientId or (#clients == 1 and clients[1].id or nil)
  local repo = repositories.repository(input.repo)
  if repo.vcs ~= input.vcs then system.fail("Repository backend changed since selection") end
  if input.directory then
    normalizedDirectory(input.directory, "Worktree directory must be a normalized absolute directory")
  end
  if input.directory and input.path then system.fail("Directory cannot be combined with an existing worktree path") end
  local destination, checkout, branch, workspaceName, base, root, detail
  if input.vcs == "git" then
    if (not not input.branch) == not not input.path then
      system.fail("Select exactly one branch or existing worktree path")
    end
    if input.path and input.worktreeName then system.fail("Worktree name only applies to a branch checkout") end
    if input.branch then
      root = input.directory and path.dirname(input.directory) or config.resolveWorktreeRoot(repo.path)
      local planned = git.planWorktree(
        repo.path,
        input.branch,
        root,
        input.directory and path.basename(input.directory) or input.worktreeName,
        repo
      )
      if input.directory and planned.path ~= input.directory then
        system.fail("Branch is already checked out at a different directory")
      end
      destination, branch = planned.path, input.branch
      checkout = planned.existing and "existing"
        or (contains(git.listBranches(repo.path), branch) and "attach" or "create")
      if checkout == "create" then base = git.repositoryHead(repo.path) end
    else
      destination = fs.realPath(input.path)
      local tree = find(git.listWorktrees(repo.path), function(entry) return entry.path == destination end)
      if not tree then system.fail(destination .. " is not a Git worktree of " .. repo.path) end
      branch, checkout = tree.branch, "existing"
    end
    if checkout == "existing" and input.branch then
      detail = "Branch " .. branch .. " is already checked out; opening its existing worktree."
    elseif checkout == "attach" then
      detail = "Branch " .. branch .. " already exists; attaching a checkout, not creating the branch."
    end
  else
    if
      (not not input.path) == not not input.worktreeName
      or (input.path and input.revision)
      or (not input.path and not input.revision)
    then
      system.fail("Select an existing workspace path or a new workspace name and base revision")
    end
    if input.path then
      destination = fs.realPath(input.path)
      local tree = find(
        jj.listWorkspaces(repo.path),
        function(entry) return entry.path == destination and entry.present end
      )
      if not tree then system.fail(destination .. " is not an available JJ workspace of " .. repo.path) end
      workspaceName, checkout = tree.name, "existing"
    else
      if input.directory and path.basename(input.directory) ~= input.worktreeName then
        system.fail("Workspace name must match the directory name")
      end
      root = input.directory and path.dirname(input.directory) or config.resolveWorktreeRoot(repo.path)
      local planned = jj.planWorkspace(repo.path, input.worktreeName, input.revision, root, repo)
      destination, workspaceName, base, checkout = planned.path, planned.workspaceName, planned.base, "create"
    end
  end
  local warning = not clientId
      and #clients > 1
      and "Multiple Rex apps are connected; select the session in the intended app"
    or nil
  local target
  if input.session.kind == "existing" and (not input.additional or input.split) then
    local ok, records = system.try(state.associations)
    if not ok then
      warning = join(warning, system.message(records), "; ")
      records = {}
    end
    local candidates = {}
    for _, entry in ipairs(records) do
      if
        entry.vcs == repo.vcs
        and entry.hostId == host.id
        and entry.commonDir == repo.commonDir
        and entry.path == destination
        and entry.sessionId == input.session.id
      then
        candidates[#candidates + 1] = entry
      end
    end
    local blocks = #candidates > 0 and rex.localBlocks(input.session.id) or {}
    for _, entry in ipairs(candidates) do
      local block = find(blocks, function(item) return item.block_id == entry.blockId end)
      if block and block.window_id == entry.windowId and liveBlock(input.session.id, entry.blockId, destination) then
        target = { windowId = entry.windowId, blockId = entry.blockId }
        break
      end
    end
  end
  local action = input.split and target and "split"
    or (target and not input.additional and not input.split and "focus" or "new-tab")
  local nameRole = action == "focus" and "none" or (action == "split" and "pane" or "tab")
  if nameRole ~= "none" then validName(input.name, nameRole) end
  if input.split and not target then detail = "No live tab for this checkout; opening a new tab instead." end
  if input.vcs == "jj" and checkout == "create" then
    detail = join(
      detail,
      "Creating a JJ workspace snapshots "
        .. repo.path
        .. "; its working-copy commit and colocated Git index intent-to-add entries may change.",
      " "
    )
  end
  local normalized = copy(input)
  normalized.repo = repo.path
  if input.path then normalized.path = destination end
  if input.vcs == "git" and input.directory then normalized.worktreeName = path.basename(input.directory) end
  local label = action == "focus" and "Focus existing tab"
    or (
      checkout == "create" and (input.vcs == "git" and "Create worktree & open" or "Create workspace & open")
      or (checkout == "attach" and "Attach branch & open" or (action == "split" and "Open pane" or "Open tab"))
    )
  return {
    vcs = input.vcs,
    input = normalized,
    hostId = host.id,
    clientId = clientId,
    path = destination,
    worktreeRoot = root,
    action = action,
    target = target,
    nameRole = nameRole,
    name = nameRole ~= "none" and input.name or nil,
    detail = detail,
    warning = warning,
    checkout = checkout,
    branch = input.vcs == "git" and (branch or system.json.null) or nil,
    workspaceName = workspaceName,
    base = base,
    label = label,
  }
end

function M.sameLaunchPlan(a, b)
  local x, y = a.input, b.input
  if
    a.vcs ~= b.vcs
    or x.vcs ~= y.vcs
    or a.hostId ~= b.hostId
    or a.worktreeRoot ~= b.worktreeRoot
    or a.clientId ~= b.clientId
    or x.repo ~= y.repo
    or not sameSession(x.session, y.session)
  then
    return false
  end
  for _, key in ipairs({ "path", "directory", "worktreeName", "name", "clientId", "additional", "split" }) do
    if x[key] ~= y[key] then return false end
  end
  for _, key in ipairs({ "path", "checkout", "action", "nameRole", "name" }) do
    if a[key] ~= b[key] then return false end
  end
  if
    (a.target and a.target.windowId) ~= (b.target and b.target.windowId)
    or (a.target and a.target.blockId) ~= (b.target and b.target.blockId)
  then
    return false
  end
  if a.vcs == "git" then
    return x.branch == y.branch
      and a.branch == b.branch
      and (a.base and a.base.head) == (b.base and b.base.head)
      and (a.base and a.base.branch) == (b.base and b.base.branch)
  end
  return x.revision == y.revision and a.workspaceName == b.workspaceName and sameRevision(a.base, b.base)
end
local function taskSettings()
  return { rexBinDir = system.getenv("REX_BIN_DIR"), rexLocalEndpoint = system.getenv("REX_WORKTREES_LOCAL_ENDPOINT") }
end
local function commandArgs(command, verb, request)
  local args = { table.unpack(command) }
  args[#args + 1] = verb
  args[#args + 1] = system.json.encode(request)
  return args
end
function M.launch(input, command, reviewed, expectedHostId)
  if not command[1] or not path.isAbsolute(command[1]) then
    system.fail("The task executable must be an absolute path")
  end
  local plan = M.planLaunch(input, expectedHostId)
  if reviewed and not M.sameLaunchPlan(reviewed, plan) then
    system.fail("Launch plan changed since review; inspect the destination before submitting again")
  end
  if plan.action == "focus" then
    if not plan.target or plan.input.session.kind ~= "existing" then
      system.fail("The reviewed focus target is no longer available")
    end
    local warning = join(
      plan.warning,
      rex.focus(plan.input.session.id, plan.target.windowId, plan.target.blockId, plan.clientId),
      "; "
    )
    return {
      hostId = plan.hostId,
      sessionId = plan.input.session.id,
      windowId = plan.target.windowId,
      blockId = plan.target.blockId,
      path = plan.path,
      pending = false,
      action = plan.action,
      warning = warning,
    }
  end
  local repo = repositories.repository(plan.input.repo)
  if repo.vcs ~= plan.vcs then system.fail("Repository backend changed since review") end
  local request = taskSettings()
  request.repo, request.path, request.commonDir, request.session, request.hostId, request.vcs, request.worktreeRoot =
    repo.path, plan.path, repo.commonDir, plan.input.session, plan.hostId, plan.vcs, plan.worktreeRoot
  if plan.vcs == "git" then
    request.branch, request.worktreeName, request.base =
      plan.input.branch, plan.input.worktreeName, plan.base and plan.base.head
    if plan.checkout ~= "create" then request.checkout = plan.checkout end
  else
    request.checkout, request.workspaceName, request.base = plan.checkout, plan.workspaceName, plan.base
  end
  if not plan.name then system.fail("The reviewed Rex tab name is no longer available") end
  if plan.action == "split" and not plan.target then system.fail("The reviewed split target is no longer available") end
  local created = rex.openTerminal(
    plan.input.session,
    plan.name,
    plan.checkout == "existing" and plan.path or repo.path,
    commandArgs(command, "task", request),
    plan.action == "split" and plan.target or nil
  )
  created.hostId, created.path, created.pending, created.action = plan.hostId, plan.path, true, plan.action
  created.warning =
    join(plan.warning, rex.focus(created.sessionId, created.windowId, created.blockId, plan.clientId), "; ")
  return created
end
local function shell(cwd)
  local program = system.getenv("SHELL")
  if not program or program == "" then program = "/bin/sh" end
  if not path.isAbsolute(program) then system.fail("SHELL must be an absolute executable path") end
  local argv = path.basename(program) == "sh" and { program, "-i" } or { program, "-l", "-i" }
  system.exec(argv, { cwd = cwd })
end
local function associateTask(association)
  local ok, err = system.try(function()
    association.windowId = rex.localBlockWindow(association.sessionId, association.blockId)
    if not association.windowId then system.fail("Rex task terminal is no longer placed on its requested host") end
    state.saveAssociation(association)
  end)
  if not ok then io.stderr:write("Checkout is available; association not saved: ", system.message(err), "\n") end
end
function M.task(request)
  return rex.withOperation(function()
    local context = rex.taskContext(request.session, request, request.hostId)
    if request.vcs == "git" and not request.branch and request.worktreeName then
      system.fail("Worktree name only applies to a branch checkout")
    end
    local current = repositories.repository(request.repo)
    if current.vcs ~= request.vcs or current.commonDir ~= request.commonDir or current.path ~= request.repo then
      system.fail("Repository identity changed since launch")
    end
    local destination
    if request.vcs == "jj" then
      if request.checkout == "create" then
        if not request.base then system.fail("New JJ workspace requires a pinned base revision") end
        local planned =
          jj.planWorkspace(request.repo, request.workspaceName, request.base.commitId, request.worktreeRoot, current)
        if
          planned.path ~= request.path
          or planned.workspaceName ~= request.workspaceName
          or not sameRevision(planned.base, request.base)
        then
          system.fail("JJ workspace destination or pinned base changed since launch")
        end
        local created = jj.createWorkspace(request.repo, request.workspaceName, request.base, request.worktreeRoot)
        if not created.path or not created.present then
          system.fail("JJ workspace registration has no available checkout; inspect " .. request.path)
        end
        destination = fs.realPath(created.path)
      else
        if request.base then system.fail("Existing JJ workspace cannot change its base revision") end
        destination = fs.realPath(request.path)
        if
          not find(
            jj.listWorkspaces(request.repo),
            function(tree) return tree.path == destination and tree.name == request.workspaceName and tree.present end
          )
        then
          system.fail("Selected JJ workspace no longer belongs to repository")
        end
      end
    elseif request.branch then
      local plan = git.planWorktree(request.repo, request.branch, request.worktreeRoot, request.worktreeName, current)
      if plan.path ~= request.path or (request.checkout == "existing" and not plan.existing) then
        system.fail("Worktree destination changed since launch")
      end
      if request.checkout == "existing" then
        destination = fs.realPath(request.path)
      else
        destination = fs.realPath(
          git.createWorktree(
            request.repo,
            request.branch,
            {
              attachOnly = request.checkout == "attach" or nil,
              startPoint = request.base,
              worktreeName = request.worktreeName,
              worktreeRoot = request.worktreeRoot,
            }
          ).path
        )
      end
    else
      destination = fs.realPath(request.path)
      if not find(git.listWorktrees(request.repo), function(tree) return tree.path == destination end) then
        system.fail("Selected worktree no longer belongs to repository")
      end
    end
    if destination ~= request.path then system.fail("Worktree path changed; checkout remains at " .. destination) end
    associateTask({
      vcs = request.vcs,
      hostId = request.hostId,
      commonDir = current.commonDir,
      path = destination,
      sessionId = context.sessionId,
      blockId = context.blockId,
    })
    shell(destination)
  end)
end

local function sameOrigin(actual, requested)
  if actual == requested then return true end
  local a, b = git.githubRepository(actual), git.githubRepository(requested)
  return a ~= nil and b ~= nil and a.identity == b.identity
end

function M.cloneDestination(destination, url, vcs, sourceHostId)
  vcs = vcs or "git"
  normalizedDirectory(destination, "Clone destination must be a normalized absolute directory")
  local parts = {}
  for part in destination:gmatch("[^/]+") do
    parts[#parts + 1] = part
  end
  local current = "/"
  for index, part in ipairs(parts) do
    local parent = current
    current = path.join(current, part)
    local ok, info = system.try(function() return fs.lstat(current) end)
    if not ok then
      if not system.missing(info) then error(info, 0) end
      info = nil
    end
    if info and info.type == "SymbolicLink" then system.fail("Symlinked clone destination: " .. current) end
    if index < #parts and info and info.type ~= "Directory" then system.fail("Not a directory: " .. current) end
    if index < #parts and info and (git.gitContext(current) or fs.exists(path.join(current, ".jj"))) then
      system.fail(
        (
          vcs == "git" and "Clone destination is inside a checkout or Git metadata: "
          or "Clone destination is inside a checkout or VCS metadata: "
        ) .. current
      )
    end
    if index == #parts and info then
      if info.type ~= "Directory" then system.fail("Clone destination already exists: " .. current) end
      local success, repo = system.try(function() return repositories.repository(current) end)
      if not success then
        if system.missing(repo) or (repo.args and contains(repo.args, "rev-parse")) then
          system.fail("Clone destination already exists and is not a repository: " .. current)
        end
        error(repo, 0)
      end
      if repo.path ~= current or repo.vcs ~= vcs then
        system.fail("Clone destination is not the requested " .. vcs .. " repository: " .. current)
      end
      local actual = repo.vcs == "git" and git.origin(current)
        or jj.cloneSource(current, sourceHostId or rex.localHost().id, repo, false).url
      if not sameOrigin(actual, url) then system.fail("Clone destination belongs to a different origin: " .. current) end
      return repo.commonDir
    end
    if parent == current then system.fail("Invalid clone destination") end
  end
end
function M.checkCloneParent(destination)
  local ancestor = path.dirname(destination)
  while true do
    local ok, result = system.try(function() return fs.lstat(ancestor) end)
    if ok then break end
    if not system.missing(result) then error(result, 0) end
    local parent = path.dirname(ancestor)
    if parent == ancestor then error(result, 0) end
    ancestor = parent
  end
  local ok, err = system.try(function() fs.access(ancestor, "wx") end)
  if not ok then
    system.fail(
      "Cannot create clone destination "
        .. destination
        .. ": "
        .. ancestor
        .. " is not writable; choose another destination or fix its permissions",
      { cause = err }
    )
  end
end
local function validateCloneDestination(input)
  if input.directory then
    normalizedDirectory(input.directory, "Worktree directory must be a normalized absolute directory")
    if input.checkout ~= "worktree" then system.fail("Worktree directory requires a worktree checkout") end
  end
  if input.checkout == "primary" and input.worktreeName then
    system.fail("Primary checkout cannot have a worktree name")
  end
  if input.vcs == "git" then
    if input.branchMode == "default" then
      if input.checkout ~= "primary" or input.branch ~= nil or input.worktreeName ~= nil or input.directory ~= nil then
        system.fail("Default branch mode requires a primary checkout without a branch or worktree")
      end
    elseif input.branchMode == "existing" or input.branchMode == "create" then
      git.validCloneBranch(input.branch, input.worktreeName)
    else
      system.fail("Invalid Git clone branch mode")
    end
  end
  if input.checkout == "worktree" and input.vcs == "jj" and not input.directory and not input.worktreeName then
    system.fail("JJ worktree checkout requires a workspace name or directory")
  end
end
function M.planClone(input, expectedHostId)
  local host = rex.localHost()
  if expectedHostId and host.id ~= expectedHostId then system.fail("Wrong Rex clone host") end
  if input.vcs ~= input.source.vcs then system.fail("Clone source backend does not match request") end
  validateCloneDestination(input)
  contracts.validate("SessionSelection", input.session)
  if
    input.session.kind == "existing"
    and not find(rex.listSessions(), function(item) return item.id == input.session.id end)
  then
    system.fail("Requested Rex session does not exist")
  end
  local clients = rex.listClients()
  if input.clientId and not find(clients, function(item) return item.id == input.clientId end) then
    system.fail("Requested Rex app client is not connected")
  end
  validName(input.name, "tab")
  if input.vcs == "jj" and input.worktreeName and not input.worktreeName:match("%S") then
    system.fail("JJ workspace name cannot be blank")
  end
  local ok, url = system.try(
    function() return git.safeOrigin(input.source.url, input.source.sourceHostId == host.id) end
  )
  if not ok then system.fail("Clone source URL is unsafe or local to another Rex host") end
  local commonDir = M.cloneDestination(input.repo, url, input.vcs, host.id)
  if not commonDir then M.checkCloneParent(input.repo) end
  local existing = commonDir ~= nil
  if
    existing
    and input.checkout == "primary"
    and input.vcs == "git"
    and input.branchMode ~= "default"
    and (input.branchMode ~= "existing" or git.repositoryHead(input.repo).branch ~= input.branch)
  then
    system.fail("Existing primary checkout is not on the requested branch")
  end
  local base
  if input.vcs == "git" then
    if existing and input.branchMode == "create" then base = git.originDefaultHead(input.repo) end
  elseif input.revision then
    if not input.revision:match("^[0-9a-f]+$") or #input.revision < 40 or #input.revision > 64 then
      system.fail("Clone base must be a full source-resolved commit ID")
    end
    if input.source.revision and input.source.revision.commitId == input.revision then base = input.source.revision end
    if not base then
      for _, choice in ipairs(input.source.revisions or {}) do
        if choice.revision.commitId == input.revision then
          base = choice.revision
          break
        end
      end
    end
    if not base then system.fail("Clone base must be resolved on the source host before transfer") end
    if existing and not sameRevision(jj.resolveRevision(input.repo, base.commitId), base) then
      system.fail("Selected source revision is not available at the destination")
    end
  end
  if input.vcs == "jj" and existing and not base then base = jj.resolveRevision(input.repo, "@-") end
  if
    input.vcs == "jj"
    and existing
    and input.checkout == "primary"
    and base
    and not sameRevision(jj.resolveRevision(input.repo, "@-"), base)
  then
    system.fail("Existing primary workspace is not based on the requested revision")
  end
  local clientId = input.clientId or (#clients == 1 and clients[1].id or nil)
  local warning = not clientId and #clients > 1 and "Multiple Rex apps are connected; select the intended app" or nil
  local snapshot
  if input.vcs == "jj" and input.checkout ~= "primary" and (input.directory or input.worktreeName or existing) then
    snapshot = "JJ "
      .. ((input.directory or input.worktreeName) and "workspace creation" or "new change")
      .. " snapshots the destination workspace at "
      .. input.repo
      .. "; its working-copy commit and colocated Git index intent-to-add entries may change."
  end
  local normalized = copy(input)
  normalized.source = copy(input.source)
  normalized.source.url = url
  return {
    vcs = input.vcs,
    input = normalized,
    hostId = host.id,
    clientId = clientId,
    repo = input.repo,
    existing = existing,
    commonDir = commonDir,
    label = existing and "Open existing repository" or "Clone & Open",
    detail = join(
      "Source " .. url .. " → " .. input.repo .. ". Only pushed history transfers; credentials stay on this machine.",
      snapshot,
      " "
    ),
    warning = warning,
    base = base,
  }
end
function M.sameClonePlan(a, b)
  local x, y = a.input, b.input
  if
    a.vcs ~= b.vcs
    or x.vcs ~= y.vcs
    or a.hostId ~= b.hostId
    or a.clientId ~= b.clientId
    or a.repo ~= b.repo
    or a.existing ~= b.existing
    or a.commonDir ~= b.commonDir
    or x.repo ~= y.repo
    or not sameSession(x.session, y.session)
  then
    return false
  end
  for _, key in ipairs({ "clientId", "name", "worktreeName", "directory", "checkout" }) do
    if x[key] ~= y[key] then return false end
  end
  if x.source.url ~= y.source.url or x.source.sourceHostId ~= y.source.sourceHostId then return false end
  if a.vcs == "git" then return a.base == b.base and x.branch == y.branch and x.branchMode == y.branchMode end
  return sameRevision(a.base, b.base) and x.revision == y.revision
end
function M.launchClone(input, command, reviewed, expectedHostId)
  if not command[1] or not path.isAbsolute(command[1]) then
    system.fail("The task executable must be an absolute path")
  end
  local plan = M.planClone(input, expectedHostId)
  if reviewed and not M.sameClonePlan(reviewed, plan) then
    system.fail("Clone plan changed since review; inspect before submitting again")
  end
  local home = system.getenv("HOME")
  if not home or not path.isAbsolute(home) then system.fail("Target HOME must be an absolute directory") end
  local request = taskSettings()
  request.plan = plan
  local created = rex.openTerminal(plan.input.session, input.name, home, commandArgs(command, "clone-task", request))
  created.hostId, created.repo, created.pending = plan.hostId, plan.repo, true
  created.warning =
    join(plan.warning, rex.focus(created.sessionId, created.windowId, created.blockId, plan.clientId), "; ")
  return created
end
function M.prepareCloneCheckout(plan)
  local input = plan.input
  validateCloneDestination(input)
  if plan.repo ~= input.repo then system.fail("Clone destination changed since review") end
  local ok, url = system.try(
    function() return git.safeOrigin(input.source.url, input.source.sourceHostId ~= nil and input.source.sourceHostId == plan.hostId) end
  )
  if not ok then system.fail("Clone source URL is unsafe or local to another Rex host") end
  if url ~= input.source.url or input.vcs ~= plan.vcs then system.fail("Clone source changed since review") end
  local observed = M.cloneDestination(plan.repo, url, plan.vcs, plan.hostId)
  if observed ~= plan.commonDir or (observed ~= nil) ~= plan.existing then
    system.fail("Clone destination identity changed since review")
  end
  if
    plan.vcs == "git"
    and plan.existing
    and input.branchMode == "create"
    and (not plan.base or plan.base ~= git.originDefaultHead(plan.repo))
  then
    system.fail("Origin default branch changed since review")
  end
  if
    plan.vcs == "jj"
    and plan.existing
    and plan.base
    and not sameRevision(jj.resolveRevision(plan.repo, plan.base.commitId), plan.base)
  then
    system.fail("JJ clone base changed since review")
  end
  if not plan.existing then
    local parent = path.dirname(plan.repo)
    fs.makeDirectory(parent, { recursive = true })
    if M.cloneDestination(plan.repo, url, plan.vcs, plan.hostId) then
      system.fail("Clone target appeared since launch; destination left untouched")
    end
    if fs.realPath(parent) ~= parent then system.fail("Clone parent changed to a symlink") end
    local parentInfo = fs.lstat(parent)
    fs.makeDirectory(plan.repo)
    local reserved = fs.lstat(plan.repo)
    local after = fs.lstat(parent)
    if
      parentInfo.dev ~= after.dev
      or parentInfo.ino ~= after.ino
      or fs.realPath(parent) ~= parent
      or fs.realPath(plan.repo) ~= plan.repo
      or reserved.type ~= "Directory"
    then
      system.fail("Clone path changed; reserved destination retained at " .. plan.repo)
    end
    if plan.vcs == "git" then
      git.cloneRepository(
        url,
        plan.repo,
        input.checkout == "primary" and input.branchMode == "existing" and input.branch or nil
      )
    else
      jj.cloneRepository(url, plan.repo)
    end
    local now = fs.lstat(plan.repo)
    if now.dev ~= reserved.dev or now.ino ~= reserved.ino or now.type ~= "Directory" then
      system.fail("Clone path changed; inspect " .. plan.repo)
    end
  end
  local repo = repositories.repository(plan.repo)
  if repo.path ~= plan.repo or repo.vcs ~= plan.vcs or (plan.existing and repo.commonDir ~= plan.commonDir) then
    system.fail("Clone repository changed; retained at " .. plan.repo)
  end
  local actual = repo.vcs == "git" and git.origin(repo.path) or jj.cloneSource(repo.path, plan.hostId, repo, false).url
  if not sameOrigin(actual, url) then system.fail("Clone origin changed; retained at " .. plan.repo) end
  local cwd
  if plan.vcs == "jj" then
    local base = plan.base or jj.resolveRevision(repo.path, "@-")
    local workspaceName = input.directory and path.basename(input.directory) or input.worktreeName
    local root = input.directory and path.dirname(input.directory)
      or (workspaceName and config.resolveWorktreeRoot(repo.path) or nil)
    if input.checkout == "primary" and plan.existing then
      if not sameRevision(jj.resolveRevision(repo.path, "@-"), base) then
        system.fail("Existing primary workspace changed since review")
      end
      cwd = repo.path
    elseif workspaceName then
      local planned = jj.planWorkspace(repo.path, workspaceName, base.commitId, root, repo)
      if not sameRevision(planned.base, base) or (input.directory and planned.path ~= input.directory) then
        system.fail("JJ clone base or directory is unavailable; clone retained at " .. plan.repo)
      end
      local created = jj.createWorkspace(repo.path, planned.workspaceName, base, root)
      if not created.path or not created.present or created.path ~= planned.path then
        system.fail("JJ workspace registration changed; clone retained at " .. plan.repo)
      end
      cwd = created.path
    elseif plan.existing or input.revision then
      local created = jj.newChange(repo.path, base)
      if not created.path or not created.present or created.path ~= repo.path then
        system.fail("JJ default workspace changed; clone retained at " .. plan.repo)
      end
      cwd = created.path
    else
      cwd = repo.path
    end
  else
    local localBranches, remote = git.listBranches(repo.path), git.remoteBranches(repo.path)
    local branch, mode = input.branch, input.branchMode
    if input.checkout == "primary" then
      if plan.existing then
        if mode ~= "default" and (mode ~= "existing" or git.repositoryHead(repo.path).branch ~= branch) then
          system.fail("Existing primary checkout is not on the requested branch")
        end
      elseif mode == "create" then
        if contains(localBranches, branch) or contains(remote, branch) then
          system.fail("Branch " .. branch .. " already exists; clone retained at " .. plan.repo)
        end
        git.createPrimaryBranch(repo.path, branch)
      elseif mode ~= "default" and git.repositoryHead(repo.path).branch ~= branch then
        system.fail("Cloned primary checkout is not on " .. branch .. "; clone retained at " .. plan.repo)
      end
      cwd = repo.path
    else
      local root = input.directory and path.dirname(input.directory) or config.resolveWorktreeRoot(repo.path)
      local name = input.directory and path.basename(input.directory) or input.worktreeName
      if mode == "existing" then
        if not contains(localBranches, branch) and not contains(remote, branch) then
          system.fail("Branch " .. branch .. " was not pushed to origin; clone retained at " .. plan.repo)
        end
        local planned = git.planWorktree(repo.path, branch, root, name, repo)
        if input.directory and planned.path ~= input.directory then
          system.fail("Branch is already checked out at a different directory")
        end
        if contains(localBranches, branch) then
          cwd = planned.existing and planned.path
            or git.createWorktree(repo.path, branch, { attachOnly = true, worktreeRoot = root, worktreeName = name }).path
        else
          cwd = git.createWorktree(
            repo.path,
            branch,
            { startPoint = git.remoteBranchHead(repo.path, branch), worktreeRoot = root, worktreeName = name }
          ).path
        end
      else
        if contains(localBranches, branch) or contains(remote, branch) then
          system.fail("Branch " .. branch .. " already exists; clone retained at " .. plan.repo)
        end
        local base = plan.existing and plan.base or git.repositoryHead(repo.path).head
        if not base then system.fail("Origin default branch changed since review") end
        cwd =
          git.createWorktree(repo.path, branch, { startPoint = base, worktreeRoot = root, worktreeName = name }).path
      end
    end
  end
  return { repo = repo, cwd = fs.realPath(cwd) }
end
function M.cloneTask(request)
  return rex.withOperation(function()
    local plan = request.plan
    local context = rex.taskContext(plan.input.session, request, plan.hostId)
    local input = plan.input
    if plan.vcs == "jj" and input.revision and plan.base and not input.source.revision then
      input = copy(input)
      input.source = copy(input.source)
      input.source.revision = plan.base
    end
    if not M.sameClonePlan(plan, M.planClone(input, plan.hostId)) then
      system.fail("Clone target changed since launch; destination left untouched")
    end
    local prepared = M.prepareCloneCheckout(plan)
    local ok, err = system.try(function() state.rememberCloneRoot(path.dirname(prepared.repo.path)) end)
    if not ok then
      io.stderr:write(
        "Checkout ",
        prepared.cwd,
        " is available; clone parent not remembered: ",
        system.message(err),
        "\n"
      )
    end
    associateTask({
      vcs = prepared.repo.vcs,
      hostId = plan.hostId,
      commonDir = prepared.repo.commonDir,
      path = prepared.cwd,
      sessionId = context.sessionId,
      blockId = context.blockId,
    })
    shell(prepared.cwd)
  end)
end
return M
