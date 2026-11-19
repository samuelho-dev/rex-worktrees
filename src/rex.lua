local system = require("runtime")
local contracts = require("contracts")
local M = {}
local json = system.json

local operation

function M.withOperation(fn)
  local previous = operation
  if not previous or previous.pid ~= system.pid() then operation = { pid = system.pid() } end
  local result = table.pack(pcall(fn))
  operation = previous
  if not result[1] then error(result[2], 0) end
  return table.unpack(result, 2, result.n)
end

local function name(value) return value:lower():gsub("%.$", ""):gsub("%.local$", "") end
function M.localDirectoryUri(raw)
  if type(raw) ~= "string" or raw:find("\0", 1, true) then return nil end
  if raw:sub(1, 1) == "/" then return raw end
  local authority, path = raw:match("^file://([^/]*)(/.*)$")
  if not authority or path:find("[?#]") or authority:find("[@:]") then return nil end
  authority = name(authority)
  if authority ~= "" and authority ~= "localhost" and authority ~= name(system.hostname()) then return nil end
  local position = 1
  while true do
    local index = path:find("%", position, true)
    if not index then break end
    if not path:sub(index + 1, index + 2):match("^%x%x$") then return nil end
    position = index + 3
  end
  path = path:gsub("%%(%x%x)", function(hex) return string.char(tonumber(hex, 16)) end)
  if path:find("\0", 1, true) or not utf8.len(path) then return nil end
  return path
end
local function binary()
  local dir = system.getenv("REX_BIN_DIR")
  if dir and not system.path.isAbsolute(dir) then system.fail("REX_BIN_DIR must be an absolute directory") end
  return dir and system.path.join(dir, "rex") or "rex"
end
local function environment()
  local env = system.environment()
  env.REX_SERVER, env.REX_HOST, env.REX_CLIENT = nil, nil, nil
  return env
end
local function run(args) return system.run(binary(), args, nil, environment()) end
local function append(into, from)
  for _, item in ipairs(from) do
    into[#into + 1] = item
  end
  return into
end
function M.machinesRegistry() return contracts.decode("RexRegistry", run({ "hosts", "list", "--json" })) end
local function readLocalIdentity()
  local endpoint = system.getenv("REX_WORKTREES_LOCAL_ENDPOINT")
  if endpoint and endpoint:sub(1, 8) ~= "unix:///" then
    system.fail(
      "Rex did not provide a local Unix endpoint; set REX_WORKTREES_LOCAL_ENDPOINT to this machine's native Unix endpoint"
    )
  end
  local args = endpoint and { "-S", endpoint } or {}
  append(args, { "--autostart=false", "whoami", "--json" })
  local identity = contracts.decode("RexIdentity", run(args))
  if
    identity.endpoint:sub(1, 8) ~= "unix:///"
    or identity.principal.transport ~= "unix"
    or (endpoint and identity.endpoint ~= endpoint)
  then
    system.fail("Rex is not connected to the selected local Unix server")
  end
  return identity
end
local function localIdentity()
  if not operation or operation.pid ~= system.pid() then return readLocalIdentity() end
  if not operation.identity then operation.identity = readLocalIdentity() end
  return operation.identity
end
function M.rex(args)
  local endpoint = system.getenv("REX_WORKTREES_LOCAL_ENDPOINT")
  if endpoint and endpoint:sub(1, 8) ~= "unix:///" then
    system.fail(
      "Rex did not provide a local Unix endpoint; set REX_WORKTREES_LOCAL_ENDPOINT to this machine's native Unix endpoint"
    )
  end
  endpoint = endpoint or localIdentity().endpoint
  return run(append({ "-S", endpoint, "--autostart=false" }, args))
end
function M.remoteRex(selector, args)
  return run(append({ "-S", selector, "--autostart=false", "--timeout", "30s" }, args))
end
function M.remoteIdentity(selector)
  return contracts.decode("RexIdentity", M.remoteRex(selector, { "whoami", "--json" }))
end
function M.localHost() return { id = localIdentity().host_id, label = "This machine" } end
function M.listSessions()
  local result = json.array()
  for _, item in ipairs(contracts.decode("RexSessions", M.rex({ "ls", "--json" })).sessions) do
    result[#result + 1] = { id = item.session_id, label = item.label }
  end
  return result
end
function M.listClients()
  local result = json.array()
  local response = contracts.decode(
    "RexClients",
    M.rex({ "api", "call", "client.list", json.encode({ kinds = json.array({ "app" }) }) })
  )
  for _, item in ipairs(response.clients) do
    if item.info and item.info ~= json.null and item.info.kind == "app" and item.connection_state == "connected" then
      result[#result + 1] = { id = item.client_id, label = item.info.label or item.client_id }
    end
  end
  return result
end
function M.localBlocks(sessionId)
  local host = M.localHost()
  local response = contracts.decode(
    "RexBlocks",
    M.rex({ "api", "call", "-s", sessionId, "session.list_blocks", json.encode({ session_id = sessionId }) })
  )
  local result = json.array()
  for _, item in ipairs(response.blocks) do
    if item.host_id == host.id and item.placement == "placed" then result[#result + 1] = item end
  end
  return result
end
function M.localBlockWindow(sessionId, blockId)
  for _, item in ipairs(M.localBlocks(sessionId)) do
    if item.block_id == blockId and item.window_id ~= json.null then return item.window_id end
  end
end
function M.originDirectory(sessionId, blockId)
  if not M.localBlockWindow(sessionId, blockId) then return nil end
  local result = contracts.decode("RexDirectory", M.rex({ "block", "call", "-s", sessionId, "-b", blockId, "pwd" }))
  local directory = result.pwd and M.localDirectoryUri(result.pwd)
  if directory then return directory end
  local info = contracts.decode("RexProcess", M.rex({ "block", "call", "-s", sessionId, "-b", blockId, "process" }))
  local cwd = info.foreground and info.foreground ~= json.null and info.foreground.cwd
  if type(cwd) == "string" and cwd:sub(1, 1) == "/" and not cwd:find("\0", 1, true) then return cwd end
end
local function terminalLayout(command, cwd, label, completion, size)
  local argv = json.array()
  local path, config = system.getenv("PATH"), system.getenv("REX_WORKTREES_CONFIG")
  if path or config then
    argv[#argv + 1] = "/usr/bin/env"
    if path then argv[#argv + 1] = "PATH=" .. path end
    if config then argv[#argv + 1] = "REX_WORKTREES_CONFIG=" .. config end
  end
  append(argv, command)
  local options = { command = argv, shell = "none", cwd = cwd, exit = { on_completion = completion or false } }
  if size then options.size = size end
  return { block = { flavor = "com.superlogical.terminal.shell", label = label, options = options } }
end
function M.openTerminal(session, label, cwd, command, target)
  local layout = terminalLayout(command, cwd, label)
  local sessionId, created
  if session.kind == "new" then
    local request =
      { label = session.name, initial_windows = json.array({ { window_label = label, layout = layout } }) }
    local response =
      contracts.decode("RexSessionCreated", M.rex({ "api", "call", "session.create", json.encode(request) }))
    sessionId, created = response.session_id, response.initial_windows[1]
  elseif target then
    sessionId = session.id
    local request = {
      session_id = sessionId,
      anchor_id = target.blockId,
      direction = "horizontal",
      side = "after",
      layout = layout,
      focus = true,
    }
    local response = contracts.decode(
      "RexSplitCreated",
      M.rex({ "api", "call", "-s", sessionId, "session.new_split", json.encode(request) })
    )
    created = { window_id = target.windowId, block_ids = response.block_ids }
  else
    sessionId = session.id
    local request = { session_id = sessionId, window_label = label, layout = layout, focus = true }
    created = contracts.decode(
      "RexCreated",
      M.rex({ "api", "call", "-s", sessionId, "session.new_window", json.encode(request) })
    )
  end
  if not created or not created.block_ids[1] then system.fail("Rex did not return the created window and terminal") end
  return { sessionId = sessionId, windowId = created.window_id, blockId = created.block_ids[1] }
end
function M.taskContext(session, settings, expectedHostId)
  if settings.rexBinDir then
    if not system.path.isAbsolute(settings.rexBinDir) then system.fail("REX_BIN_DIR must be absolute") end
    system.setenv("REX_BIN_DIR", settings.rexBinDir)
  end
  if settings.rexLocalEndpoint then system.setenv("REX_WORKTREES_LOCAL_ENDPOINT", settings.rexLocalEndpoint) end
  local identity = contracts.validate("RexTaskIdentity", system.environment())
  local sessionId, blockId = identity.REX_SESSION, identity.REX_BLOCK
  if session.kind == "existing" and session.id ~= sessionId then
    system.fail("Task must run in its requested Rex session and terminal")
  end
  if M.localHost().id ~= expectedHostId or not M.localBlockWindow(sessionId, blockId) then
    system.fail("Task must run in a placed terminal on its requested Rex host")
  end
  return { sessionId = sessionId, blockId = blockId }
end
function M.focus(sessionId, windowId, blockId, clientId)
  local warnings = {}
  local ok, err = system.try(
    function()
      return M.rex({
        "api",
        "call",
        "-s",
        sessionId,
        "session.focus_block",
        json.encode({ session_id = sessionId, block_id = blockId }),
      })
    end
  )
  if not ok then warnings[#warnings + 1] = "Could not focus Rex pane: " .. system.message(err) end
  if clientId then
    ok, err = system.try(
      function()
        return M.rex({
          "api",
          "call",
          "client.perform",
          json.encode({
            client_id = clientId,
            action = "session.select",
            args = { session_id = sessionId, window_id = windowId },
          }),
        })
      end
    )
    if not ok then warnings[#warnings + 1] = "Could not focus Rex app: " .. system.message(err) end
  end
  if #warnings > 0 then return table.concat(warnings, "; ") end
end
local function findPane(node, blockId)
  if not node or node == json.null then return nil end
  if node.block_id == blockId then return node end
  if node.split and node.split ~= json.null then
    return findPane(node.split.before, blockId) or findPane(node.split.after, blockId)
  end
end
function M.openPopup(command, sessionId, origin)
  origin = origin or {}
  local view = contracts.decode(
    "RexView",
    M.rex({ "api", "call", "-s", sessionId, "session.view", json.encode({ session_id = sessionId }) })
  )
  local source, owner
  for _, window in ipairs(view.windows) do
    for _, layer in ipairs(window.layers) do
      for _, block in ipairs(layer.blocks) do
        if block.block_id == origin.blockId then
          source, owner = window, block.owner
        end
      end
    end
  end
  if origin.blockId and not source then system.fail("Source pane is no longer in the selected Rex session") end
  local windowId = source and source.window_id or view.active_window_id
  local window
  for _, item in ipairs(view.windows) do
    if item.window_id == windowId then
      window = item
      break
    end
  end
  if not window then system.fail("No active Rex window for the popup") end
  local clients, clientId = M.listClients()
  for _, id in ipairs({ owner or false, origin.clientId or false }) do
    for _, client in ipairs(clients) do
      if id and id == client.id then
        clientId = id
        break
      end
    end
    if clientId then break end
  end
  local popupCommand = json.array()
  append(popupCommand, command)
  if clientId then append(popupCommand, { "--origin-client", clientId }) end
  local first, focused, selected
  for _, layer in ipairs(window.layers) do
    for _, block in ipairs(layer.blocks) do
      if block.flavor == "com.superlogical.terminal.shell" then
        first = first or block
        if block.block_id == window.focused_block_id then focused = block end
        if block.block_id == origin.blockId then selected = block end
      end
    end
  end
  local terminal = selected or focused or first
  local width, height = 1, 1
  local size = contracts.popupSize
  if terminal then
    local pane
    for _, layer in ipairs(window.layers) do
      pane = findPane(layer.layout, terminal.block_id)
      if pane then break end
    end
    if not pane then system.fail("Rex terminal geometry changed before opening the popup") end
    local actual =
      contracts.decode("RexTerminalSize", M.rex({ "block", "call", "-s", sessionId, "-b", terminal.block_id, "size" }))
    local zoomed = window.zoomed_block_id == terminal.block_id
    width = math.min(1, (size.columns + 2) * (zoomed and 1 or pane.rect[3]) / actual.columns)
    height = math.min(1, (size.rows + 3) * (zoomed and 1 or pane.rect[4]) / actual.rows)
  end
  local request = {
    session_id = sessionId,
    window_id = windowId,
    bounds = json.array({ (1 - width) / 2, (1 - height) / 2, width, height }),
    layout = terminalLayout(popupCommand, system.cwd(), "Worktrees", true, size),
    focus = true,
  }
  local created =
    contracts.decode("RexLayer", M.rex({ "api", "call", "-s", sessionId, "session.new_layer", json.encode(request) }))
  local hasBlock = false
  if created.block_ids and not system.isNull(created.block_ids) then
    for _, id in ipairs(created.block_ids) do
      if id and not system.isNull(id) then
        hasBlock = true
        break
      end
    end
  end
  if not created.layer_id or system.isNull(created.layer_id) or not hasBlock then
    system.fail("Rex did not return a floating terminal layer")
  end
  return created
end
for _, key in ipairs({ "localBlocks", "originDirectory", "openPopup", "taskContext", "focus" }) do
  local fn = M[key]
  M[key] = function(...)
    local args = table.pack(...)
    return M.withOperation(function() return fn(table.unpack(args, 1, args.n)) end)
  end
end
return M
