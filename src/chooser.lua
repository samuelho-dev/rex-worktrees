local runtime = require("runtime")
local unicode = runtime.unicode
local path = runtime.path
local M = {}
local function copy(t)
  local r = {}
  for k, v in pairs(t) do
    r[k] = v
  end
  return r
end
local function trim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
local function present(v) return v ~= nil and not runtime.isNull(v) end
local function safe(s, whitespace) return unicode.sanitize(tostring(s or ""), whitespace) end
local function directoryFor(d)
  if d.destination and present(d.destination.path) then return d.destination.path end
  if d.clone and not d.isCreating then return d.clone.repo end
  if d.directory then return d.directory end
  local repo = d.clone and d.clone.repo or d.project and d.project.path
  local name = d.worktreeName or d.destination and d.destination.branch
  if repo and name then return (d.worktreeRoot or repo .. ".worktrees"):gsub("/$", "") .. "/" .. name end
end
function M.generatedName(d)
  return d.clone and not d.isCreating and (d.projectChoice and d.projectChoice.name or "Project")
    or d.worktreeName
    or d.destination and d.destination.label
    or d.projectChoice and d.projectChoice.name
    or "Worktree"
end
function M.inputFor(d)
  if not (d.host and d.project and d.projectChoice and d.destination and d.session) then return end
  local result = {
    repo = d.project.vcs == "jj" and (d.sourcePath or d.project.path) or d.project.path,
    session = d.session,
    name = M.generatedName(d),
    clientId = d.clientId,
    additional = d.mode == "new-tab",
    split = d.mode == "split",
    vcs = d.project.vcs,
  }
  if present(d.destination.path) then
    result.path = d.destination.path
    return result
  end
  result.directory = directoryFor(d)
  if not result.directory then return end
  if d.project.vcs == "jj" then
    if not (d.worktreeName and d.destination.revision) then return end
    result.worktreeName, result.revision = d.worktreeName, d.destination.revision
  else
    if not d.destination.branch then return end
    result.branch, result.worktreeName = d.destination.branch, d.worktreeName
  end
  return result
end
function M.changeProjectChoice(d, choice)
  local r = copy(d)
  r.projectChoice = choice
  r.project, r.clone, r.destination, r.worktreeName, r.directory, r.worktreeRoot, r.sourcePath =
    nil, nil, nil, nil, nil, nil, nil
  r.isCreating = false
  return r
end
function M.changeProject(d, candidate)
  local r = copy(d)
  local same = d.project and d.project.vcs == candidate.vcs and d.project.commonDir == candidate.commonDir
  r.project, r.clone = candidate, nil
  if not same then
    r.destination, r.worktreeName, r.directory, r.sourcePath = nil, nil, nil, nil
  end
  r.isCreating = not not (same and d.isCreating)
  if candidate.vcs ~= "jj" then r.sourcePath = nil end
  return r
end
function M.changeDestination(d, candidate, name)
  local r = copy(d)
  r.destination = candidate
  r.worktreeName = name
  if present(candidate.path) then
    r.worktreeName, r.directory, r.isCreating = nil, nil, false
  end
  return r
end
function M.selectWorktree(d, tree)
  if not present(tree.path) or tree.vcs == "jj" and not tree.present then
    runtime.fail(
      "Workspace "
        .. (tree.vcs == "jj" and tree.name or tostring(tree.path))
        .. " is unavailable; inspect its registered location before opening"
    )
  end
  local r = M.changeDestination(
    d,
    { path = tree.path, worktree = tree, label = tree.vcs == "jj" and tree.name or path.basename(tree.path) }
  )
  if tree.vcs == "jj" then
    r.sourcePath = tree.path
    if d.projectChoice and d.projectChoice.source and d.host and d.projectChoice.source.hostId == d.host.hostId then
      r.projectChoice = copy(d.projectChoice)
      r.projectChoice.source = copy(d.projectChoice.source)
      r.projectChoice.source.checkoutPath = tree.path
    end
  end
  return r
end
function M.selectRevision(d, choice)
  return M.changeDestination(d, { revision = choice.revision.commitId, label = choice.label }, d.worktreeName)
end
function M.cloneInputFor(d)
  if not (d.host and d.clone and d.session and path.isAbsolute(d.clone.repo)) then return end
  local directory = d.isCreating and directoryFor(d) or nil
  if
    d.isCreating
    and (not directory or d.clone.vcs == "git" and d.destination and d.destination.branch == d.clone.branch)
  then
    return
  end
  local result = {
    vcs = d.clone.vcs,
    repo = d.clone.repo,
    session = d.session,
    clientId = d.clientId,
    checkout = d.isCreating and "worktree" or "primary",
    directory = directory,
    name = M.generatedName(d),
    worktreeName = d.isCreating and d.worktreeName or nil,
  }
  local source = { vcs = d.clone.vcs, url = d.clone.url, sourceHostId = d.clone.sourceHostId }
  result.source = source
  if d.clone.vcs == "jj" then
    local revision = d.destination and d.destination.revision
    if revision then
      if d.clone.revision and d.clone.revision.commitId == revision then
        source.revision = d.clone.revision
      else
        for _, choice in ipairs(d.clone.revisions or {}) do
          if choice.revision.commitId == revision then
            source.revision = choice.revision
            break
          end
        end
      end
    end
    source.revisions = runtime.json.array()
    result.revision = revision
  else
    if not (d.destination and d.destination.branch) then return end
    result.branch = d.destination.branch
    result.branchMode = "create"
    for _, branch in ipairs(d.clone.branches or {}) do
      if branch == result.branch then
        result.branchMode = "existing"
        break
      end
    end
    source.branches, source.branch = runtime.json.array(), d.clone.branch
  end
  return result
end

local client = require("client")
local contracts = require("contracts")
local json = runtime.json

local function known(host, repo, checkout)
  local source = { machineKey = host.key, hostId = host.hostId, repository = repo }
  if repo.vcs == "jj" and present(checkout) and checkout.vcs == "jj" and checkout.commonDir == repo.commonDir then
    source.checkoutPath = checkout.path
  end
  return { name = repo.name, source = source }
end

local function clonePath(state, choice)
  if choice.name and choice.name ~= "." and choice.name ~= ".." and not choice.name:find("[/\\%c]")
    and safe(choice.name) == choice.name and state.cloneRoot ~= "" then
    return state.cloneRoot:gsub("/$", "") .. "/" .. choice.name
  end
end

local function originDirectory(machine, origin)
  if not (origin.sessionId and origin.blockId) then return nil end
  local rex = require("rex")
  if machine["local"] then return rex.originDirectory(origin.sessionId, origin.blockId) end
  local host = client.connectMachine(machine)
  local function call(method, schema)
    return contracts.decode(schema, rex.remoteRex(host.selector,
      { "block", "call", "-s", origin.sessionId, "-b", origin.blockId, method }))
  end
  local ok, info = pcall(call, "process", "RexProcess")
  local cwd = ok and info.foreground and not runtime.isNull(info.foreground) and info.foreground.cwd
  if type(cwd) == "string" and path.isAbsolute(cwd) and not cwd:find("\0", 1, true) then return cwd end
  local got, pwd = pcall(call, "pwd", "RexDirectory")
  if got and type(pwd.pwd) == "string" then
    local authority = pwd.pwd:match("^file://([^/]*)/")
    if pwd.pwd:sub(1, 1) == "/" or authority == "" or authority == "localhost" then
      return rex.localDirectoryUri(pwd.pwd)
    end
  end
end

local function focusClient(state, clients)
  local d = state.draft
  for _, item in ipairs(clients or {}) do
    if item.id == d.clientId then return item.id end
  end
  if state.originMachine == d.machine.key then
    for _, item in ipairs(clients or {}) do
      if item.id == state.origin.clientId then return item.id end
    end
  end
  if #(clients or {}) == 1 then return clients[1].id end
end

local function bind(state, command, choice, host, available)
  local source = choice.source
  local same = source and source.machineKey == host.key and source.hostId == host.hostId
  local matches = {}
  for _, repo in ipairs(available) do
    if repo.name == choice.name and (not source or repo.vcs == source.repository.vcs) then
      matches[#matches + 1] = repo
    end
  end
  local directory = same and (source.checkoutPath or source.repository.path) or choice.path
  if not directory and #matches == 1 then directory = matches[1].path end
  if not directory and #matches > 1 then
    runtime.fail("Multiple projects named " .. choice.name .. " on this machine; select its exact project directory")
  end
  directory = directory or (source and clonePath(state, choice))
  local function clone(repo)
    if not source then runtime.fail("Choose a known source project before cloning") end
    local machine
    for _, item in ipairs(client.listMachines()) do
      if item.key == source.machineKey then machine = item end
    end
    if not machine then runtime.fail("Source Rex machine is no longer registered") end
    local sourceHost = client.connectMachine(machine)
    if sourceHost.hostId ~= source.hostId then runtime.fail("Source Rex host identity changed; select the project again") end
    local inventory = client.sourceForClone(sourceHost, command, source.checkoutPath or source.repository.path)
    inventory.repo = repo
    return { clone = inventory }
  end
  if not directory then
    if source then return clone("") end
    runtime.fail("Select a known project or enter its absolute directory on this machine")
  end
  if not path.isAbsolute(directory) then runtime.fail("Project directory must be an absolute path on this machine") end
  local ok, found = pcall(client.inspectProject, host, command, directory)
  if not ok then
    if source and runtime.message(found):find("Project directory does not exist:", 1, true) == 1 then
      return clone(directory)
    end
    error(found, 0)
  end
  if same and (found.project.vcs ~= source.repository.vcs or found.project.commonDir ~= source.repository.commonDir) then
    runtime.fail("Project directory changed; select the exact project directory again")
  end
  return { found = found }
end

local function applyBinding(state, choice, result, preserve)
  local d = state.draft
  if not preserve then d = M.changeProjectChoice(d, choice) end
  if result.clone then
    if not preserve then
      d.clone = result.clone
      if d.clone.vcs == "git" and present(d.clone.branch) then
        d.destination = { branch = d.clone.branch, label = d.clone.branch }
      end
    end
  else
    local found = result.found
    d = M.changeProject(d, found.project)
    d.worktreeRoot = found.worktreeRoot
    if found.checkout.vcs == "jj" and not d.sourcePath then d.sourcePath = found.checkout.path end
    if not d.destination then
      for _, tree in ipairs(found.worktrees) do
        if tree.path == found.checkout.path
          and (tree.vcs == "jj" and tree.present or tree.vcs == "git" and not tree.bare and not tree.prunable) then
          d = M.selectWorktree(d, tree)
          break
        end
      end
    end
  end
  state.draft = d
end

local function activate(state, command, machine, context)
  local previous = state.draft
  local found = client.connectAndDiscover(machine, command, context)
  local host = found.host
  local preserve = previous.machine and previous.machine.key == machine.key and previous.host
    and previous.host.hostId == host.hostId
  state.draft = preserve and copy(previous) or { machine = machine, projectChoice = previous.projectChoice, mode = previous.mode }
  local d = state.draft
  d.machine, d.host = machine, host
  state.cloneRoot, state.sessions = present(found.cloneRoot) and found.cloneRoot or "", found.sessions or json.array()
  local retained = json.array()
  for _, item in ipairs(state.projects) do
    if not item.source or item.source.machineKey ~= machine.key or item.source.hostId ~= host.hostId then
      retained[#retained + 1] = item
    end
  end
  for _, repo in ipairs(found.projects or {}) do retained[#retained + 1] = known(host, repo, found.checkout) end
  state.projects = retained
  local valid = d.session and d.session.kind == "new"
  for _, item in ipairs(state.sessions) do
    if d.session and d.session.kind == "existing" and item.id == d.session.id then valid = true end
  end
  if not valid then
    d.session = nil
    if state.originMachine == machine.key then
      for _, item in ipairs(state.sessions) do
        if item.id == state.origin.sessionId then d.session = { kind = "existing", id = item.id } end
      end
    end
    if not d.session and #state.sessions == 1 then d.session = { kind = "existing", id = state.sessions[1].id } end
  end
  d.clientId = focusClient(state, found.clients)
  local choice = previous.projectChoice
  local result
  if not choice and present(found.checkout) and context then
    result = { found = client.inspectProject(host, command, found.checkout.path) }
    choice = known(host, result.found.project, result.found.checkout)
  elseif choice then
    result = bind(state, command, choice, host, found.projects or {})
  end
  if choice and result then applyBinding(state, choice, result, preserve and previous.projectChoice ~= nil) end
end

local function view(state)
  local d = state.draft
  local jj = (d.clone and d.clone.vcs or d.project and d.project.vcs) == "jj"
  local tree = d.destination and present(d.destination.path) and d.destination.worktree
  local ready = d.host and (d.project or d.clone)
  local directory = directoryFor(d)
  local session = d.session and d.session.kind == "new" and "New: " .. d.session.name or nil
  if not session and d.session then
    for _, item in ipairs(state.sessions) do if item.id == d.session.id then session = item.label end end
  end
  local branch
  if tree and tree.vcs == "jj" then
    branch = tree.changeId:sub(1, 12) .. " · " .. tree.head:sub(1, 12)
  elseif tree then
    branch = present(tree.branch) and tree.branch or "Detached HEAD · " .. tree.head:sub(1, 12)
  elseif jj then
    branch = d.destination and d.destination.revision and d.destination.label or d.clone and "Cloned default" or "Choose a starting revision"
  else
    branch = d.destination and d.destination.branch or "Select or type branch"
  end
  local rows = json.array({
    { id = "project", label = "Project", value = d.projectChoice and d.projectChoice.name or "Choose a project" },
    { id = "machine", label = "Machine", value = d.machine and d.machine.label or "Choose Rex host",
      detail = d.host and "Host ID: " .. d.host.hostId or d.machine and d.machine.selector },
    { id = "session", label = "Session", value = session or d.session and d.session.id or "Choose or type new session",
      detail = d.session and (d.session.kind == "existing" and d.session.id or "Create on submit"), disabled = not d.host },
    { id = "destination", label = jj and "Workspace" or "Worktree",
      value = d.clone and not d.isCreating and "Project checkout (after clone)"
        or d.isCreating and (jj and "Create new workspace…" or "Create new worktree…")
        or d.destination and d.destination.label or (jj and "Choose a workspace" or "Choose a worktree"),
      disabled = not ready },
    { id = "branch", label = tree and tree.vcs == "jj" and "Revision" or jj and "Start from" or "Branch",
      value = branch, isReadOnly = not not tree, disabled = not ready or not tree and not d.clone and not d.isCreating },
    { id = "checkoutName", label = "Directory", value = directory and directory ~= "" and directory
        or (d.clone and "Choose an absolute directory" or "Choose a branch first"),
      detail = directory, isReadOnly = not not tree, disabled = not ready or not d.clone and not directory },
    { id = "mode", label = "Mode", value = d.clone and "New tab (cloning)"
        or d.mode == "auto" and "Reuse matching tab, otherwise new tab"
        or d.mode == "new-tab" and "Always new tab" or "Split matching tab, otherwise new tab",
      isReadOnly = not not d.clone, disabled = not d.host },
  })
  local response = {
    rows = rows,
    submitLabel = d.clone and "Clone & open" or tree and (jj and "Open workspace" or "Open worktree")
      or jj and "Create workspace & open" or "Create worktree & open",
    submitDisabled = not not (state.blocked or not d.host or not (M.cloneInputFor(d) or M.inputFor(d))),
    error = state.error,
    notice = d.clone and ("This project will be cloned onto this machine: "
      .. (d.clone.repo ~= "" and d.clone.repo or "choose its Directory") .. ". Only pushed history transfers.") or nil,
  }
  return response
end

local function addChoice(choices, value, title, detail)
  choices[#choices + 1] = { id = tostring(#choices + 1), value = value, title = title, detail = detail }
end

local function editor(state, field, title, choices, allowOther)
  state.editor = { field = field, kind = "pick", title = title, choices = choices, allowOther = allowOther }
end

local function openField(state, command, field)
  local d, choices = state.draft, json.array()
  for _, row in ipairs(view(state).rows) do
    if row.id == field and (row.disabled or row.isReadOnly) then runtime.fail("This field is not editable") end
  end
  if field == "project" then
    for _, item in ipairs(state.projects) do
      addChoice(choices, item, item.name, (item.source and item.source.repository.path or item.path or "") .. " · Source machine")
    end
    editor(state, field, "Project", choices, true)
  elseif field == "machine" then
    for _, item in ipairs(client.listMachines()) do
      addChoice(choices, item, item.label, item["local"] and "This machine" or "Rex host · " .. item.selector)
    end
    editor(state, field, "Execution machine", choices, false)
  elseif field == "session" then
    local found = client.inspectSessions(d.host, command)
    state.sessions, d.clientId = found.sessions, focusClient(state, found.clients)
    for _, item in ipairs(state.sessions) do addChoice(choices, item.id, item.label, item.id) end
    editor(state, field, "Session", choices, true)
  elseif field == "mode" then
    addChoice(choices, "auto", "Reuse matching tab", "Focus existing task, otherwise open new tab")
    addChoice(choices, "new-tab", "Always new tab")
    addChoice(choices, "split", "Split matching task", "Opens new tab when no live target exists")
    editor(state, field, "Open mode", choices, false)
  elseif field == "checkoutName" then
    local proposed = d.clone and not d.isCreating and d.projectChoice and clonePath(state, d.projectChoice)
      or directoryFor(setmetatable({ directory = false }, { __index = d }))
    if proposed then addChoice(choices, proposed, "Use proposed directory", proposed) end
    editor(state, field, "Directory (absolute path on selected machine)", choices, true)
  elseif field == "destination" or field == "branch" then
    local jj = (d.clone and d.clone.vcs or d.project.vcs) == "jj"
    local found = d.clone and { worktrees = {}, branches = d.clone.branches or {}, revisions = d.clone.revisions or {} }
      or client.inspectWorktrees(d.host, command, jj and (d.sourcePath or d.project.path) or d.project.path)
    if field == "destination" then
      local trees = json.array()
      for _, tree in ipairs(found.worktrees or {}) do
        if tree.vcs == "jj" or not tree.bare and not tree.prunable then
          trees[#trees + 1] = tree
          addChoice(choices, tree, tree.vcs == "jj" and ((tree.present and "" or "Unavailable: ") .. tree.name)
            or path.basename(tree.path), present(tree.path) and tree.path or "Location unknown")
        end
      end
      if d.clone then addChoice(choices, "primary", "Project checkout (after clone)", d.clone.repo) end
      addChoice(choices, "create", jj and "Create new workspace…" or "Create new worktree…")
      editor(state, field, jj and "Workspace" or "Worktree", choices, false)
      state.editor.trees, state.editor.revisions, state.editor.worktreeRoot = trees, found.revisions or json.array(), found.worktreeRoot
    elseif jj then
      if d.clone then addChoice(choices, json.null, "Cloned default") end
      for _, choice in ipairs(found.revisions or {}) do
        addChoice(choices, choice, choice.label, choice.expression .. " · " .. choice.revision.commitId:sub(1, 12))
      end
      editor(state, field, "Start from revision", choices, true)
    else
      local occupied = {}
      for _, tree in ipairs(found.worktrees or {}) do
        if tree.vcs == "git" and present(tree.branch) then occupied[tree.branch] = true end
      end
      if d.clone and d.isCreating and present(d.clone.branch) then occupied[d.clone.branch] = true end
      for _, branch in ipairs(found.branches or {}) do
        if not occupied[branch] then addChoice(choices, branch, branch, d.clone and "Published branch" or "Existing branch") end
      end
      editor(state, field, "Branch", choices, true)
      state.editor.occupied = occupied
    end
  else
    runtime.fail("Unknown chooser field")
  end
end

local function accept(state, command, request)
  local e, d = state.editor, state.draft
  if not e then runtime.fail("No active editor") end
  if (request.id == nil) == (request.text == nil) then runtime.fail("Select one choice or enter text") end
  local value
  if request.id then
    local selected
    for _, choice in ipairs(e.choices) do if choice.id == request.id then selected = choice end end
    if not selected then runtime.fail("Choice is no longer available") end
    value = selected.value
  elseif e.allowOther then
    value = trim(request.text)
    if value == "" then runtime.fail("A value is required") end
  else
    runtime.fail("Select an available choice")
  end
  state.editor = nil
  if e.field == "machine" then
    activate(state, command, value)
  elseif e.field == "project" then
    local choice = request.id and value or { name = path.basename(value), path = path.isAbsolute(value) and value or nil }
    if choice.name == "" then runtime.fail("Project name is required") end
    if not d.host then
      state.draft = M.changeProjectChoice(d, choice)
    else
      local available = {}
      for _, item in ipairs(state.projects) do
        if item.source and item.source.machineKey == d.host.key and item.source.hostId == d.host.hostId then
          available[#available + 1] = item.source.repository
        end
      end
      applyBinding(state, choice, bind(state, command, choice, d.host, available))
    end
  elseif e.field == "session" then
    d.session = request.id and { kind = "existing", id = value } or { kind = "new", name = value }
  elseif e.field == "mode" then
    d.mode = value
  elseif e.field == "checkoutName" then
    if not path.isAbsolute(value) or value:find("[%z\1-\31\127]")
      or path.dirname(path.resolve(value)) == path.resolve(value) then
      runtime.fail("Directory must be an absolute non-root path on this machine")
    end
    local directory = path.resolve(value)
    if d.clone and not d.isCreating then
      d.clone.repo = directory
    else
      d.directory = directory
      if (d.clone and d.clone.vcs or d.project.vcs) == "jj" then d.worktreeName = path.basename(directory) end
    end
  elseif e.field == "destination" then
    local jj = (d.clone and d.clone.vcs or d.project.vcs) == "jj"
    if value == "primary" then
      d.isCreating, d.directory, d.worktreeName = false, nil, nil
      d.destination = present(d.clone.branch) and { branch = d.clone.branch, label = d.clone.branch } or nil
    elseif value == "create" then
      local name, suffix = "workspace", 2
      if jj then
        local used = {}
        for _, tree in ipairs(e.trees) do used[tree.name] = true end
        while used[name] do name, suffix = "workspace-" .. suffix, suffix + 1 end
      end
      local mainline
      for _, choice in ipairs(e.revisions) do if choice.expression == "trunk()" then mainline = choice break end end
      d.isCreating, d.directory, d.worktreeName = true, nil, jj and name or nil
      d.worktreeRoot = e.worktreeRoot or d.worktreeRoot
      d.destination = jj and mainline and { revision = mainline.revision.commitId, label = mainline.label }
        or { label = jj and "Create new workspace…" or "Create new worktree…" }
      if not jj then openField(state, command, "branch") end
    else
      state.draft = M.selectWorktree(d, value)
    end
  elseif e.field == "branch" then
    local jj = (d.clone and d.clone.vcs or d.project.vcs) == "jj"
    if jj then
      if request.id and not present(value) then
        d.destination = nil
      else
        local choice = value
        if not request.id then
          local host, repo = d.host, d.sourcePath or d.project and d.project.path
          if d.clone then
            local source, machine = d.projectChoice.source
            for _, item in ipairs(client.listMachines()) do if item.key == source.machineKey then machine = item end end
            if not machine then runtime.fail("Clone source machine is no longer registered") end
            host = client.connectMachine(machine)
            if host.hostId ~= source.hostId or host.hostId ~= d.clone.sourceHostId then
              runtime.fail("Clone source host identity changed; reselect the project")
            end
            repo = source.checkoutPath or source.repository.path
          end
          choice = { expression = value, label = value, revision = client.inspectRevision(host, command, repo, value) }
        end
        state.draft = M.selectRevision(d, choice)
        if d.clone then state.draft.clone.revision = choice.revision end
      end
    else
      if value == "" or value:sub(1, 1) == "-" or value:find("[%z\1-\31\127]") then
        runtime.fail("Branch name must be a valid Git branch")
      end
      if e.occupied[value] then runtime.fail("Branch " .. value .. " is already checked out; select its existing worktree instead") end
      d.destination = { branch = value, label = value }
    end
  end
end

local function submit(state, command, confirmed)
  if state.blocked then runtime.fail("Inspect the destination and session before opening again") end
  local d = state.draft
  local input = M.cloneInputFor(d) or M.inputFor(d)
  if not input then runtime.fail("Complete the required fields before submitting") end
  local clone = not not d.clone
  local plan = (clone and client.reviewClone or client.review)(d.host, command, input)
  if plan.hostId ~= d.host.hostId
    or clone and (plan.repo ~= input.repo or plan.input.checkout ~= input.checkout or plan.input.directory ~= input.directory)
    or not clone and (input.path and plan.path ~= input.path or input.directory and plan.path ~= input.directory) then
    runtime.fail("Destination changed; select the machine and destination again")
  end
  if confirmed and (not state.confirmation or state.confirmation.warning ~= plan.warning) then
    runtime.fail("Safety warning changed; review the destination again")
  end
  if plan.warning and not confirmed then
    state.confirmation = { warning = plan.warning }
    return
  end
  state.confirmation = nil
  local ok, result = pcall(clone and client.submitClone or client.submit, d.host, command, input, plan)
  if not ok then
    state.blocked = true
    state.error = runtime.message(result) .. " · Destination: " .. (clone and plan.repo or plan.path)
      .. " · The checkout or Rex tab may already have changed. Inspect the destination and session before opening again."
    return
  end
  state.done, state.result = true, result
  state.notice = result.warning or plan.warning
end

function M.request(request, command)
  contracts.validate("ChooserRequest", request)
  local state
  if request.op == "start" then
    if request.state then runtime.fail("Start does not accept state") end
    state = { draft = { mode = "auto" }, origin = request.origin or json.object(), projects = json.array(),
      sessions = json.array(), cloneRoot = "" }
    local machines = client.listMachines()
    local function find(selected)
      for _, machine in ipairs(machines) do
        if selected and (machine.key == selected or machine.selector == selected or machine.label == selected)
          or not selected and machine["local"] then return machine end
      end
    end
    local source = find(state.origin.server)
    local target = source
    if request.machine then target = find(request.machine) end
    if source then
      state.originMachine = source.key
      local ok, err = pcall(function()
        local context = request.context
        if context and not path.isAbsolute(context) then runtime.fail("Context must be an absolute path") end
        context = context or originDirectory(source, state.origin)
        activate(state, command, source, context)
        if target and target.key ~= source.key then activate(state, command, target) end
      end)
      if not ok then state.error = runtime.message(err) end
    else
      state.error = "Origin machine " .. tostring(state.origin.server) .. " is not in Rex hosts. Select a connected machine."
    end
    if request.machine and not target then
      state.error = "Machine " .. request.machine .. " is not in Rex hosts. Select a connected machine."
    end
  else
    if not request.state then runtime.fail("Chooser state is required") end
    state = contracts.decode("ChooserState", request.state)
    if state.done then runtime.fail("Chooser is already complete") end
    local before = json.encode(state)
    state.error = nil
    local ok, err = pcall(function()
      if request.op == "edit" then
        if state.editor or state.confirmation then runtime.fail("Finish or cancel the current prompt first") end
        openField(state, command, request.field)
      elseif request.op == "accept" then
        accept(state, command, request)
      elseif request.op == "cancel" then
        state.editor, state.confirmation = nil, nil
      elseif request.op == "submit" then
        if state.editor or state.confirmation then runtime.fail("Finish or cancel the current prompt first") end
        submit(state, command, false)
      elseif request.op == "confirm" then
        if not state.confirmation then runtime.fail("No safety confirmation is pending") end
        submit(state, command, true)
      end
    end)
    if not ok then
      state = contracts.decode("ChooserState", before)
      state.error = runtime.message(err)
    end
  end
  local response = view(state)
  if state.editor then
    local items = json.array()
    for _, choice in ipairs(state.editor.choices) do
      items[#items + 1] = { id = choice.id, title = choice.title, detail = choice.detail }
    end
    response.editor = { kind = state.editor.kind, title = state.editor.title, items = items, allowOther = state.editor.allowOther }
  end
  if state.confirmation then response.confirmation = { title = "Confirm safety warning", detail = state.confirmation.warning } end
  if state.done then
    response.done, response.result, response.notice = true, state.result, state.notice
  else
    response.state = json.encode(state)
  end
  for _, row in ipairs(response.rows) do
    row.label, row.value = safe(row.label), safe(row.value)
    if row.detail then row.detail = safe(row.detail) end
  end
  if response.error then response.error = safe(response.error) end
  if response.notice then response.notice = safe(response.notice) end
  if response.editor then
    response.editor.title = safe(response.editor.title)
    for _, item in ipairs(response.editor.items) do
      item.title = safe(item.title)
      if item.detail then item.detail = safe(item.detail) end
    end
  end
  if response.confirmation then
    response.confirmation.title = safe(response.confirmation.title)
    response.confirmation.detail = safe(response.confirmation.detail)
  end
  return contracts.validate("ChooserResponse", response)
end

return M
