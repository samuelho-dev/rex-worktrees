local runtime = require("runtime")
local unicode = runtime.unicode
local path = runtime.path
local M = {}
local rowCount = 7
local minRows = require("contracts").popupSize.rows
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
local function pad(s, n) return s .. string.rep(" ", math.max(0, n - unicode.width((s:gsub("\27%[[%d;]*m", ""))))) end
local codes = { cyan = "\27[36m", amber = "\27[33m", muted = "\27[90m", red = "\27[31m", bold = "\27[1m" }
local function color(s, tone, enabled) return enabled and codes[tone] .. s .. "\27[0m" or s end
function M.renderFormFrame(view, focused, columns, rows, colors, options)
  if colors == nil then colors = not runtime.getenv("NO_COLOR") end
  options = options or {}
  local width = math.max(2, columns)
  if rows < minRows then
    return unicode.fit(("Rex Worktrees needs %d terminal rows. Resize this pane; Esc closes."):format(minRows), width)
  end
  local screen = {}
  local function add(s)
    local remaining, out, pos = width, {}, 1
    while pos <= #s do
      local first, last = s:find("\27%[[%d;]*m", pos)
      local text = s:sub(pos, first and first - 1 or #s)
      local part = unicode.fit(text, remaining, "…")
      out[#out + 1] = part
      remaining = math.max(0, remaining - unicode.width(part))
      if not first then break end
      out[#out + 1] = s:sub(first, last)
      pos = last + 1
    end
    screen[#screen + 1] = pad(table.concat(out), width)
  end
  add(color("REX", "cyan", colors) .. " " .. color("/ WORKTREES", "bold", colors))
  add(color(string.rep("─", width), "muted", colors))
  local current, destination
  for _, row in ipairs(view.rows) do
    if row.id == focused then current = row end
    if row.id == "destination" then destination = row end
    local active = focused == row.id
    local tone = row.disabled and "muted" or active and "cyan" or "bold"
    local value = safe(row.value)
    if value == "" then value = "—" end
    add(
      color(active and "›" or " ", tone, colors)
        .. " "
        .. color(pad(unicode.fit(safe(row.label):upper(), 13), 13), tone, colors)
        .. "  "
        .. color(unicode.fit(value, math.max(1, width - 17), "…"), tone, colors)
    )
  end
  local heading =
    unicode.fit(safe(options.editor and options.editor.title or current and current.label or "Details") .. " ", width)
  add(color(heading .. string.rep("─", math.max(0, width - unicode.width(heading))), "muted", colors))
  local lines = {}
  local subtitle = current and current.detail or destination and destination.detail
  for _, message in ipairs({ view.error or false, view.notice or false, subtitle or false }) do
    if message then
      for _, line in ipairs(unicode.wrap(safe(message), math.max(1, width - 8))) do
        lines[#lines + 1] = line
      end
    end
  end
  local count = rows - rowCount - 4
  local visible = options.editor and 1 or count
  local offset = math.max(0, math.min(options.detailOffset or 0, #lines - visible))
  local function detail(i)
    return (i == 1 and offset > 0 and "↑ " or "")
      .. (lines[offset + i] or "")
      .. (i == visible and offset + visible < #lines and " ↓ PgDn" or "")
  end
  if options.editor then
    for i = 1, count - 1 do
      add(options.editor.lines[i] or "")
    end
    add(view.error and color(detail(1), "red", colors) or "")
  else
    for i = 1, count do
      add(color(detail(i), view.error and "red" or view.notice and "amber" or "muted", colors))
    end
  end
  local function hint(k, label) return color(k, "bold", colors) .. " " .. color(label, "muted", colors) end
  local function button(label, active, primary, disabled)
    return color(
      (active and "›" or " ") .. "[ " .. safe(label) .. " ]",
      disabled and "muted" or active and "cyan" or primary and "bold" or "muted",
      colors
    )
  end
  add(
    options.footer and color(options.footer, "muted", colors)
      or options.editor and (hint("Enter", "accept") .. " · " .. hint("Esc", "back") .. " · " .. hint(
        "↑↓",
        "choices"
      ) .. " · " .. hint("PgUp/PgDn", "details"))
      or (
        button((view.submitLabel or "Open") .. " · Ctrl+S", focused == "submit", true, view.submitDisabled)
        .. " "
        .. button("Cancel · Esc", focused == "cancel")
        .. "  "
        .. hint("Tab", "next")
      )
  )
  return table.concat(screen, "\r\n")
end
local function matches(choices, text)
  local result, query = {}, unicode.fold(text)
  for i, choice in ipairs(choices) do
    if unicode.fold(choice.title .. " " .. (choice.description or "")):find(query, 1, true) then
      result[#result + 1] = i - 1
    end
  end
  return result
end
-- Choice indexes deliberately remain zero-based, as in the original pure API.
function M.advanceInputChoice(state, name, text, choices, selectionOnly)
  local function nextstate(value, selected) return { _tag = "NextFrame", state = { text = value, selected = selected } } end
  if name == "escape" or name == "ctrl_c" then return { _tag = "Submit", value = runtime.json.null } end
  if name == "ctrl_u" then return nextstate("", selectionOnly and state.selected or nil) end
  local found = matches(choices, state.text)
  if name == "up" or name == "down" or name == "tab" then
    if #found == 0 then return { _tag = "Beep" } end
    local current = name == "up" and 1 or 0
    if present(state.selected) then
      current = 0
      for i, v in ipairs(found) do
        if v == state.selected then
          current = i
          break
        end
      end
    end
    return nextstate(state.text, found[(current + (name == "up" and -1 or 1) - 1) % #found + 1])
  end
  if name == "enter" or name == "ctrl_s" then
    if present(state.selected) then
      for _, i in ipairs(found) do
        if i == state.selected then
          return { _tag = "Submit", value = { kind = "selected", value = choices[i + 1].value } }
        end
      end
    end
    if not selectionOnly and trim(state.text) ~= "" then
      return { _tag = "Submit", value = { kind = "typed", text = state.text } }
    end
    return { _tag = "Beep" }
  end
  if name == "backspace" or name == "delete" then
    return nextstate(unicode.dropLastGrapheme(state.text), selectionOnly and state.selected or nil)
  end
  if text == "" or text:find("[%z\1-\31\127]") then return { _tag = "Beep" } end
  return nextstate(state.text .. text, selectionOnly and state.selected or nil)
end
function M.renderInputChoice(state, choices, columns, colors, selectionOnly, count)
  if colors == nil then colors = not runtime.getenv("NO_COLOR") end
  count = count or minRows - rowCount - 6
  local width, found = math.max(20, columns), matches(choices, state.text)
  local selected = 0
  for i, index in ipairs(found) do
    if index == state.selected then
      selected = i
      break
    end
  end
  local start = selected == 0 and 1 or math.max(1, math.min(selected, #found - count + 1))
  local text = safe(state.text, true)
  if text == "" then text = selectionOnly and "Filter exact choices…" or "Type new value…" end
  local lines = { color("›", "cyan", colors) .. " " .. unicode.fit(text, width - 2) }
  for n = start, math.min(#found, start + count - 1) do
    local index = found[n]
    local choice = choices[index + 1]
    lines[#lines + 1] = unicode.fit(
      (state.selected == index and "›" or " ")
        .. " "
        .. safe(choice.title)
        .. (choice.description and " · " .. safe(choice.description) or ""),
      width
    )
  end
  return lines
end
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

function M.popup(command, contextFn, origin, preferredMachine)
  local terminal = require("terminal")
  local client = require("client")
  origin = origin or {}
  local draft, machines, projects, sessions = { mode = "auto" }, {}, {}, {}
  local focus, errorText, blocked, cloneRoot = "project", nil, false, ""
  local editor, notice, pending, detailOffset, branchPending = nil, nil, nil, 0, false
  local function failure(message) runtime.fail(message) end
  local function known(host, repository, checkout)
    local source = { machineKey = host.key, hostId = host.hostId, repository = repository }
    if
      repository.vcs == "jj"
      and present(checkout)
      and checkout.vcs == "jj"
      and checkout.commonDir == repository.commonDir
    then
      source.checkoutPath = checkout.path
    end
    return { name = repository.name, source = source }
  end
  local function focusClient(clients)
    for _, item in ipairs(clients or {}) do
      if item.id == draft.clientId then return item.id end
    end
    if draft.host and draft.host["local"] then
      for _, item in ipairs(clients or {}) do
        if item.id == origin.clientId then return item.id end
      end
    end
    if #(clients or {}) == 1 then return clients[1].id end
  end
  local function useProject(found)
    draft = M.changeProject(draft, found.project)
    draft.worktreeRoot = found.worktreeRoot
    if found.checkout.vcs == "jj" and not draft.sourcePath then draft.sourcePath = found.checkout.path end
    if not draft.destination then
      for _, tree in ipairs(found.worktrees) do
        if
          tree.path == found.checkout.path
          and (tree.vcs == "jj" and tree.present or tree.vcs == "git" and not tree.bare and not tree.prunable)
        then
          draft = M.selectWorktree(draft, tree)
          break
        end
      end
    end
  end
  local function clonePath(choice)
    if
      choice.name
      and choice.name ~= "."
      and choice.name ~= ".."
      and not choice.name:find("[/\\%c]")
      and safe(choice.name) == choice.name
      and cloneRoot ~= ""
    then
      return cloneRoot:gsub("/$", "") .. "/" .. choice.name
    end
  end
  local function bind(choice, host, available)
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
      failure("Multiple projects named " .. choice.name .. " on this machine; select its exact project directory")
    end
    directory = directory or (source and clonePath(choice))
    local function clone(repo)
      if not source then failure("Choose a known source project before cloning") end
      local machine
      for _, item in ipairs(machines) do
        if item.key == source.machineKey then
          machine = item
          break
        end
      end
      if not machine then failure("Source Rex machine is no longer registered") end
      local sourceHost = client.connectMachine(machine)
      if sourceHost.hostId ~= source.hostId then
        failure("Source Rex host identity changed; select the project again")
      end
      local inventory = client.sourceForClone(sourceHost, command, source.checkoutPath or source.repository.path)
      inventory.repo = repo
      return { clone = inventory }
    end
    if not directory then
      if source then return clone("") end
      failure("Select a known project or enter its absolute directory on this machine")
    end
    if not path.isAbsolute(directory) then failure("Project directory must be an absolute path on this machine") end
    local ok, found = pcall(client.inspectProject, host, command, directory)
    if not ok then
      if source and runtime.message(found):find("Project directory does not exist:", 1, true) == 1 then
        return clone(directory)
      end
      error(found, 0)
    end
    if
      same and (found.project.vcs ~= source.repository.vcs or found.project.commonDir ~= source.repository.commonDir)
    then
      failure("Project directory changed; select the exact project directory again")
    end
    return { found = found }
  end
  local function applyBinding(choice, result, preserve)
    if result.clone then
      if not preserve then
        draft = M.changeProjectChoice(draft, choice)
        draft.clone = result.clone
        if draft.clone.vcs == "git" and present(draft.clone.branch) then
          draft.destination = { branch = draft.clone.branch, label = draft.clone.branch }
        end
      end
    else
      if not preserve then draft = M.changeProjectChoice(draft, choice) end
      useProject(result.found)
    end
  end
  local function view(initializing)
    local jj = (draft.clone and draft.clone.vcs or draft.project and draft.project.vcs) == "jj"
    local tree = draft.destination and present(draft.destination.path) and draft.destination.worktree
    local ready = draft.host and (draft.project or draft.clone)
    local directory = directoryFor(draft)
    local session = draft.session and draft.session.kind == "new" and "New: " .. draft.session.name or nil
    if not session and draft.session then
      for _, item in ipairs(sessions) do
        if item.id == draft.session.id then
          session = item.label
          break
        end
      end
    end
    local branch
    if tree and tree.vcs == "jj" then
      branch = tree.changeId:sub(1, 12) .. " · " .. tree.head:sub(1, 12)
    elseif tree then
      branch = present(tree.branch) and tree.branch or "Detached HEAD · " .. tree.head:sub(1, 12)
    elseif jj then
      branch = draft.destination and draft.destination.revision and draft.destination.label
        or draft.clone and "Cloned default"
        or "Choose a starting revision"
    else
      branch = draft.destination and draft.destination.branch or "Select or type branch"
    end
    local rows = {
      {
        id = "project",
        label = "Project",
        value = draft.projectChoice and draft.projectChoice.name or "Choose a project",
      },
      {
        id = "machine",
        label = "Machine",
        value = draft.machine and draft.machine.label or "Choose Rex host",
        detail = draft.host and "Host ID: " .. draft.host.hostId or draft.machine and draft.machine.selector,
      },
      {
        id = "session",
        label = "Session",
        value = session or draft.session and draft.session.id or "Choose or type new session",
        detail = draft.session and (draft.session.kind == "existing" and draft.session.id or "Create on submit"),
        disabled = not draft.host,
      },
      {
        id = "destination",
        label = jj and "Workspace" or "Worktree",
        value = draft.clone and not draft.isCreating and "Project checkout (after clone)"
          or draft.isCreating and (jj and "Create new workspace…" or "Create new worktree…")
          or draft.destination and draft.destination.label
          or (jj and "Choose a workspace" or "Choose a worktree"),
        detail = tree and "Branch and Directory describe this worktree; select another worktree to change them."
          or draft.isCreating
            and (jj and "Choose the starting revision and directory for the new workspace." or "Choose an unused branch or a new branch name, then its directory."),
        disabled = not ready,
      },
      {
        id = "branch",
        label = tree and tree.vcs == "jj" and "Revision" or jj and "Start from" or "Branch",
        value = branch,
        detail = not tree
          and (
            jj and "Revision for the new workspace; the source workspace is not moved."
            or "Select an unused existing branch, or type the name of a new branch."
          ),
        isReadOnly = not not tree,
        disabled = not ready or not tree and not draft.clone and not draft.isCreating,
      },
      {
        id = "checkoutName",
        label = "Directory",
        value = directory ~= "" and directory
          or (draft.clone and "Choose an absolute directory" or "Choose a branch first"),
        detail = directory,
        isReadOnly = not not tree,
        disabled = not ready or not draft.clone and not directory,
      },
      {
        id = "mode",
        label = "Mode",
        value = draft.clone and "New tab (cloning)"
          or draft.mode == "auto" and "Reuse matching tab, otherwise new tab"
          or draft.mode == "new-tab" and "Always new tab"
          or "Split matching tab, otherwise new tab",
        isReadOnly = not not draft.clone,
        disabled = not draft.host,
      },
    }
    if initializing then
      for _, row in ipairs(rows) do
        row.disabled = true
      end
    end
    local problem = errorText
      or (
        not draft.projectChoice and "Select a project"
        or not draft.machine and "Select a Rex machine"
        or not draft.host and "Connect to the selected machine and install its worktrees helper if missing"
        or not ready and "Select the exact project directory on this machine"
        or not draft.destination and not draft.clone and "Choose an existing worktree or Create new worktree…"
        or not jj and not tree and not (draft.destination and draft.destination.branch) and "Choose a branch"
        or jj and draft.isCreating and not (draft.destination and draft.destination.revision) and not draft.clone and "Choose a starting revision"
        or not directory and "Choose an absolute directory"
        or not draft.session and "Choose an existing Rex session or type a new name"
      )
    return {
      rows = rows,
      submitLabel = draft.clone and "Clone & open"
        or tree and (jj and "Open workspace" or "Open worktree")
        or jj and "Create workspace & open"
        or "Create worktree & open",
      submitDisabled = initializing or blocked or not draft.host or not (M.cloneInputFor(draft) or M.inputFor(draft)),
      notice = initializing and "Discovering projects and Rex sessions…"
        or draft.clone
          and ("This project will be cloned onto this machine: " .. (draft.clone.repo ~= "" and draft.clone.repo or "choose its Directory") .. ". Only pushed history transfers."),
      error = not initializing and problem or nil,
    }
  end
  local function start(fn, done, label) pending = { job = runtime.background(fn), done = done, label = label } end
  local function activate(machine, context)
    local previous, previousHost = draft, draft.host and draft.host.hostId
    draft = { machine = machine, projectChoice = draft.projectChoice, mode = draft.mode }
    sessions = {}
    cloneRoot = ""
    errorText = nil
    start(function()
      local found = client.connectAndDiscover(machine, command, context)
      local choice = previous.projectChoice
      local inspected
      if not choice and present(found.checkout) and present(context) then
        inspected = { found = client.inspectProject(found.host, command, found.checkout.path) }
        choice = known(found.host, inspected.found.project, inspected.found.checkout)
      elseif choice then
        cloneRoot = present(found.cloneRoot) and found.cloneRoot or ""
        inspected = bind(choice, found.host, found.projects)
      end
      return { discovered = found, choice = choice, inspected = inspected }
    end, function(result)
      local found, host = result.discovered, result.discovered.host
      if previous.machine and previous.machine.key == machine.key and previousHost == host.hostId then
        draft = copy(previous)
        draft.machine, draft.host = machine, host
      else
        draft.host = host
      end
      cloneRoot, sessions = present(found.cloneRoot) and found.cloneRoot or "", found.sessions or {}
      local retained = {}
      for _, item in ipairs(projects) do
        if not item.source or item.source.machineKey ~= machine.key or item.source.hostId ~= host.hostId then
          retained[#retained + 1] = item
        end
      end
      for _, repo in ipairs(found.projects or {}) do
        retained[#retained + 1] = known(host, repo, found.checkout)
      end
      projects = retained
      local valid = draft.session and draft.session.kind == "new"
      for _, item in ipairs(sessions) do
        if draft.session and draft.session.kind == "existing" and item.id == draft.session.id then valid = true end
      end
      if not valid then
        draft.session = nil
        if host["local"] then
          for _, item in ipairs(sessions) do
            if item.id == origin.sessionId then draft.session = { kind = "existing", id = item.id } end
          end
        end
        if not draft.session and #sessions == 1 then draft.session = { kind = "existing", id = sessions[1].id } end
      end
      draft.clientId = focusClient(found.clients)
      if result.choice and result.inspected then
        applyBinding(
          result.choice,
          result.inspected,
          previous.machine
            and previous.machine.key == machine.key
            and previousHost == host.hostId
            and previous.projectChoice ~= nil
        )
      end
      errorText = nil
    end, "Connecting to " .. machine.label .. "…")
  end
  local function choose(title, choices, exact, onAccept)
    local selectedIndex
    for i, choice in ipairs(choices) do
      if choice.selected then
        selectedIndex = i - 1
        break
      end
    end
    editor = {
      title = title,
      choices = choices,
      selectionOnly = exact,
      state = { text = "", selected = selectedIndex },
      accept = onAccept,
    }
    detailOffset = 0
  end
  local function selected(value, isSelected, title, description)
    return { value = value, selected = isSelected, title = title, description = description }
  end
  local function operate(fn, done, label) start(fn, done, label or "Loading…") end
  local function openField(field)
    if field == "project" then
      local choices = {}
      for _, item in ipairs(projects) do
        choices[#choices + 1] = selected(
          item,
          false,
          item.name,
          (item.source and item.source.repository.path or item.path or "") .. " · Source machine"
        )
      end
      choose("Project (select known or type name / absolute path)", choices, false, function(picked)
        local text = picked.text and trim(picked.text)
        local choice = picked.kind == "selected" and picked.value
          or { name = path.basename(text), path = path.isAbsolute(text) and text or nil }
        if choice.name == "" then failure("Project name is required") end
        if not draft.host then
          draft = M.changeProjectChoice(draft, choice)
          return
        end
        local available = {}
        for _, item in ipairs(projects) do
          if item.source and item.source.machineKey == draft.host.key and item.source.hostId == draft.host.hostId then
            available[#available + 1] = item.source.repository
          end
        end
        operate(
          function() return bind(choice, draft.host, available) end,
          function(result) applyBinding(choice, result) end
        )
      end)
    elseif field == "machine" then
      operate(client.listMachines, function(found)
        machines = found
        if #machines == 0 then failure("No Rex machines available") end
        local choices = {}
        for _, item in ipairs(machines) do
          choices[#choices + 1] = selected(
            item,
            draft.machine and item.key == draft.machine.key,
            item.label,
            item["local"] and "This machine" or "Rex host · " .. item.selector
          )
        end
        choose("Execution machine", choices, true, function(picked) activate(picked.value) end)
      end)
    elseif field == "session" then
      operate(function() return client.inspectSessions(draft.host, command) end, function(found)
        sessions = found.sessions
        draft.clientId = focusClient(found.clients)
        local choices = {}
        for _, item in ipairs(sessions) do
          choices[#choices + 1] = selected(item.id, false, item.label, item.id)
        end
        choose(
          "Session (select existing or type new name)",
          choices,
          false,
          function(picked)
            draft.session = picked.kind == "selected" and { kind = "existing", id = picked.value }
              or { kind = "new", name = picked.text }
          end
        )
      end)
    elseif field == "mode" then
      choose("Open mode", {
        selected("auto", draft.mode == "auto", "Reuse matching tab", "Focus existing task, otherwise open new tab"),
        selected("new-tab", draft.mode == "new-tab", "Always new tab"),
        selected("split", draft.mode == "split", "Split matching task", "Opens new tab when no live target exists"),
      }, true, function(picked) draft.mode = picked.value end)
    elseif field == "checkoutName" then
      local proposed = draft.clone and not draft.isCreating and draft.projectChoice and clonePath(draft.projectChoice)
        or directoryFor(setmetatable({ directory = false }, { __index = draft }))
      local choices = proposed and { selected(proposed, false, "Use proposed directory", proposed) } or {}
      choose("Directory (absolute path on selected machine)", choices, false, function(picked)
        local text = trim(picked.kind == "selected" and picked.value or picked.text)
        if
          not path.isAbsolute(text)
          or text:find("[%z\1-\31\127]")
          or path.dirname(path.resolve(text)) == path.resolve(text)
        then
          failure("Directory must be an absolute non-root path on this machine")
        end
        local directory = path.resolve(text)
        if draft.clone and not draft.isCreating then
          draft.clone.repo = directory
        else
          draft.directory = directory
          if (draft.clone and draft.clone.vcs or draft.project.vcs) == "jj" then
            draft.worktreeName = path.basename(directory)
          end
        end
      end)
    elseif field == "destination" or field == "branch" then
      local jj = (draft.clone and draft.clone.vcs or draft.project.vcs) == "jj"
      operate(
        function()
          return draft.clone
              and { worktrees = {}, branches = draft.clone.branches or {}, revisions = draft.clone.revisions or {} }
            or client.inspectWorktrees(
              draft.host,
              command,
              jj and (draft.sourcePath or draft.project.path) or draft.project.path
            )
        end,
        function(found)
          if field == "destination" then
            local choices, trees = {}, {}
            for _, tree in ipairs(found.worktrees or {}) do
              if tree.vcs == "jj" or not tree.bare and not tree.prunable then
                trees[#trees + 1] = tree
                local title = tree.vcs == "jj" and ((tree.present and "" or "Unavailable: ") .. tree.name)
                  or path.basename(tree.path)
                local description = tree.vcs == "jj"
                    and (tree.present and present(tree.path) and tree.changeId:sub(1, 12) .. " · " .. tree.path or "Unavailable · " .. (present(
                      tree.path
                    ) and tree.path or "location unknown"))
                  or (present(tree.branch) and tree.branch or "Detached HEAD") .. " · " .. tree.path
                choices[#choices + 1] =
                  selected(tree, draft.destination and tree.path == draft.destination.path, title, description)
              end
            end
            if draft.clone then
              choices[#choices + 1] =
                selected("primary", not draft.isCreating, "Project checkout (after clone)", draft.clone.repo)
            end
            choices[#choices + 1] = selected(
              "create",
              draft.isCreating,
              jj and "Create new workspace…" or "Create new worktree…",
              jj and "Choose starting revision and directory" or "Choose branch and directory"
            )
            choose(
              jj and "Workspace (select existing or create new)" or "Worktree (select existing or create new)",
              choices,
              true,
              function(picked)
                local value = picked.value
                if value == "primary" then
                  draft.isCreating, draft.directory, draft.worktreeName = false, nil, nil
                  draft.destination = present(draft.clone.branch)
                      and { branch = draft.clone.branch, label = draft.clone.branch }
                    or nil
                elseif value == "create" then
                  local name, suffix = "workspace", 2
                  if jj then
                    local used = {}
                    for _, tree in ipairs(trees) do
                      used[tree.name] = true
                    end
                    while used[name] do
                      name = "workspace-" .. suffix
                      suffix = suffix + 1
                    end
                  end
                  local mainline
                  for _, choice in ipairs(found.revisions or {}) do
                    if choice.expression == "trunk()" then
                      mainline = choice
                      break
                    end
                  end
                  draft.isCreating, draft.directory, draft.worktreeName = true, nil, jj and name or nil
                  draft.worktreeRoot = found.worktreeRoot or draft.worktreeRoot
                  draft.destination = jj
                      and mainline
                      and { revision = mainline.revision.commitId, label = mainline.label }
                    or { label = jj and "Create new workspace…" or "Create new worktree…" }
                  branchPending = not jj
                else
                  draft = M.selectWorktree(draft, value)
                end
              end
            )
          elseif jj then
            local choices = {}
            if draft.clone then
              choices[#choices + 1] =
                selected(runtime.json.null, false, "Cloned default", "Use the clone's native default")
            end
            for _, choice in ipairs(found.revisions or {}) do
              choices[#choices + 1] = selected(
                choice,
                false,
                choice.label,
                choice.expression .. " · " .. choice.revision.commitId:sub(1, 12)
              )
            end
            choose(
              draft.clone and "Start from source revision (or cloned default)"
                or "Start from revision for new workspace",
              choices,
              false,
              function(picked)
                if picked.kind == "selected" and not present(picked.value) then
                  draft.destination = nil
                  return
                end
                local function apply(choice)
                  draft = M.selectRevision(draft, choice)
                  if draft.clone then draft.clone.revision = choice.revision end
                end
                if picked.kind == "selected" then
                  apply(picked.value)
                  return
                end
                local expression = trim(picked.text)
                operate(function()
                  local host, repo = draft.host, draft.sourcePath or draft.project and draft.project.path
                  if draft.clone then
                    local source = draft.projectChoice.source
                    local machine
                    for _, item in ipairs(machines) do
                      if item.key == source.machineKey then machine = item end
                    end
                    if not machine then failure("Clone source machine is no longer registered") end
                    host = client.connectMachine(machine)
                    if host.hostId ~= source.hostId or host.hostId ~= draft.clone.sourceHostId then
                      failure("Clone source host identity changed; reselect the project")
                    end
                    repo = source.checkoutPath or source.repository.path
                  end
                  return client.inspectRevision(host, command, repo, expression)
                end, function(revision)
                  apply({ expression = expression, label = expression, revision = revision })
                end)
              end
            )
          else
            local occupied = {}
            for _, tree in ipairs(found.worktrees or {}) do
              if tree.vcs == "git" and present(tree.branch) then occupied[tree.branch] = true end
            end
            if draft.clone and draft.isCreating and present(draft.clone.branch) then
              occupied[draft.clone.branch] = true
            end
            local choices = {}
            for _, branch in ipairs(found.branches or {}) do
              if not occupied[branch] then
                choices[#choices + 1] = selected(
                  branch,
                  false,
                  branch,
                  draft.clone and "Published branch" or "Existing branch · new worktree"
                )
              end
            end
            choose("Branch (select unused or type new name)", choices, false, function(picked)
              local branch = picked.kind == "selected" and picked.value or trim(picked.text)
              if branch == "" or branch:sub(1, 1) == "-" or branch:find("[%z\1-\31\127]") then
                failure("Branch name must be a valid Git branch")
              end
              if occupied[branch] then
                failure("Branch " .. branch .. " is already checked out; select its existing worktree instead")
              end
              draft.destination = { branch = branch, label = branch }
            end)
          end
        end
      )
    end
  end
  local function submit()
    local input = M.cloneInputFor(draft) or M.inputFor(draft)
    if not input then return end
    local clone = not not draft.clone
    operate(
      function()
        return clone and client.reviewClone(draft.host, command, input) or client.review(draft.host, command, input)
      end,
      function(plan)
        if
          plan.hostId ~= draft.host.hostId
          or clone and (plan.repo ~= input.repo or plan.input.checkout ~= input.checkout or plan.input.directory ~= input.directory)
          or not clone
            and (input.path and plan.path ~= input.path or input.directory and plan.path ~= input.directory)
        then
          errorText = plan.hostId ~= draft.host.hostId and "Rex target changed; select the machine again"
            or clone and ("Clone destination changed; edit the destination: " .. plan.repo)
            or ("Destination changed; select the worktree again: " .. plan.path)
          blocked = true
          return
        end
        start(
          function() return (clone and client.submitClone or client.submit)(draft.host, command, input, plan) end,
          function(result)
            if result.warning or not clone and plan.warning then
              notice = {
                title = clone and "Clone task submitted with warning" or "Opened with warning",
                text = "Session: "
                  .. result.sessionId
                  .. " · Destination: "
                  .. (clone and result.repo or result.path)
                  .. " · "
                  .. (result.warning or plan.warning),
                exit = true,
              }
            else
              notice = { exit = true, immediate = true }
            end
          end,
          "Submitting task…"
        )
        pending.submitted = true
        pending.fail = function(err)
          notice = {
            title = clone and "Clone needs inspection" or "Launch needs inspection",
            text = runtime.message(err)
              .. " · Destination: "
              .. (clone and plan.repo or plan.path)
              .. " · The checkout or Rex tab may already have changed. Inspect the destination and session before opening again.",
            err = err,
          }
        end
      end,
      "Reviewing destination…"
    )
  end
  local keymap = terminal.input.keymap.get_keymap({
    ["\r"] = "enter",
    ["\n"] = "enter",
    ["\t"] = "tab",
    ["\8"] = "backspace",
    ["\127"] = "backspace",
    ["\27"] = "escape",
    ["\27[Z"] = "backtab",
  })
  local function loop()
    local system = require("system")
    assert(
      system.tcsetattr(
        io.stdin,
        system.TCSANOW,
        { iflag = system.tcgetattr(io.stdin).iflag - system.I_IXON - system.I_IXOFF }
      )
    )
    start(function() return { context = contextFn(), machines = client.listMachines() } end, function(result)
      machines = result.machines
      local initial
      for _, machine in ipairs(machines) do
        if
          preferredMachine
            and (machine.key == preferredMachine or machine.selector == preferredMachine or machine.label == preferredMachine)
          or not preferredMachine and machine["local"]
        then
          initial = machine
          break
        end
      end
      if initial then
        activate(initial, initial["local"] and result.context or nil)
      elseif preferredMachine then
        errorText = "Machine " .. preferredMachine .. " is not in Rex hosts. Select a connected machine."
      end
    end, "Discovering projects and Rex sessions…")
    local lastRows, lastColumns, current
    local redraw = true
    while true do
      if pending then
        local done, ok, result = pending.job:poll()
        if done then
          redraw = true
          local completed = pending
          pending = nil
          if ok then
            local applied, err = pcall(completed.done, result)
            if not applied then errorText = runtime.message(err) end
          elseif completed.fail then
            completed.fail(result)
          elseif completed.label == "Discovering projects and Rex sessions…" then
            notice = { title = "Could not open worktrees", text = runtime.message(result), err = result }
          else
            errorText = runtime.message(result)
          end
        end
      end
      if notice and notice.immediate then return end
      if branchPending and not pending and not editor then
        branchPending = false
        focus = "branch"
        local ok, err = pcall(openField, "branch")
        if not ok then errorText = runtime.message(err) end
      end
      local rows, columns = terminal.size()
      rows, columns = rows or minRows, columns or 80
      if redraw or rows ~= lastRows or columns ~= lastColumns then
        current = view(pending ~= nil)
        if pending then current.notice = pending.label end
        if notice then
          current.error = notice.title .. " · " .. notice.text
          current.notice = nil
        end
        local options = { detailOffset = detailOffset }
        if editor then
          options.editor = {
            title = editor.title,
            lines = M.renderInputChoice(
              editor.state,
              editor.choices,
              columns,
              nil,
              editor.selectionOnly,
              math.max(1, rows - rowCount - 6)
            ),
          }
        end
        if notice then options.footer = "Enter / Space close · Esc close · PgUp/PgDn details" end
        terminal.output.write(
          "\27[?25l\27[H\27[2J",
          M.renderFormFrame(current, focus, columns, rows, nil, options),
          "\27[0J"
        )
        lastRows, lastColumns = rows, columns
        redraw = false
      end
      local raw, typ = terminal.input.readansi(0.1)
      if raw then
        redraw = true
        local key = keymap[raw] or raw
        if notice then
          if key == "pageup" or key == "pagedown" then
            detailOffset = math.max(0, detailOffset + (key == "pageup" and -1 or 1))
          elseif key == "enter" or key == "escape" or raw == " " or key == "ctrl_c" then
            if notice.err then error(notice.err, 0) end
            return
          end
        elseif editor then
          if rows >= minRows or key == "escape" or key == "ctrl_c" then
            if key == "pageup" or key == "pagedown" then
              detailOffset = math.max(0, detailOffset + (key == "pageup" and -1 or 1))
            else
              local action = M.advanceInputChoice(
                editor.state,
                key,
                typ == "char" and raw or "",
                editor.choices,
                editor.selectionOnly
              )
              if action._tag == "NextFrame" then
                editor.state = action.state
              elseif action._tag == "Submit" then
                local accepting = editor
                editor = nil
                if present(action.value) then
                  local ok, err = pcall(accepting.accept, action.value)
                  if ok then
                    blocked = false
                  else
                    errorText = runtime.message(err)
                  end
                end
              else
                terminal.bell()
              end
            end
          end
        elseif key == "escape" or key == "ctrl_c" or key == "ctrl_d" then
          if pending and pending.submitted then
            terminal.bell()
          else
            if pending then
              pending.job:kill()
              pending = nil
            end
            return
          end
        elseif rows >= minRows then
          if key == "pageup" or key == "pagedown" then
            detailOffset = math.max(0, detailOffset + (key == "pageup" and -1 or 1))
          elseif pending and not pending.submitted and (key == "backtab" or key == "tab") then
            focus = "cancel"
          elseif pending and not pending.submitted and key == "enter" and focus == "cancel" then
            pending.job:kill()
            pending = nil
            return
          elseif not pending then
            local fields = {}
            for _, row in ipairs(current.rows) do
              if not row.disabled and not row.isReadOnly then fields[#fields + 1] = row.id end
            end
            fields[#fields + 1], fields[#fields + 2] = "submit", "cancel"
            local index = 1
            for i, field in ipairs(fields) do
              if field == focus then
                index = i
                break
              end
            end
            if key == "ctrl_s" or key == "enter" and focus == "submit" then
              if not current.submitDisabled then
                submit()
              else
                terminal.bell()
              end
            elseif key == "enter" and focus == "cancel" then
              return
            elseif key == "enter" then
              errorText = nil
              local ok, err = pcall(openField, focus)
              if not ok then errorText = runtime.message(err) end
            elseif key == "up" or key == "backtab" or key == "k" then
              focus = fields[(index - 2) % #fields + 1]
            elseif key == "down" or key == "tab" or key == "j" then
              focus = fields[index % #fields + 1]
            end
          end
        end
      end
    end
  end
  local ok, result =
    pcall(terminal.initwrap(loop, { displaybackup = true, disable_sigint = true, skip_width_detection = true }))
  if pending then
    if pending.submitted then
      pcall(function() pending.job:wait() end)
    else
      pending.job:kill()
    end
  end
  if not ok then error(result, 0) end
end

return M
