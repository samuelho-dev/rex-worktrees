local system = require("runtime")
local contracts = require("contracts")
local rex = require("rex")
local json = system.json
local M = {}
local function machinesIn(registry)
  local label = registry.home.this_machine and registry.home.label ~= "" and registry.home.label or "This machine"
  local result = json.array({
    {
      key = "local",
      label = label,
      ["local"] = true,
      selector = system.getenv("REX_WORKTREES_LOCAL_ENDPOINT") or "local",
    },
  })
  for _, entry in ipairs(registry.hosts) do
    local host = entry.host
    result[#result + 1] = { key = host.id, label = host.label, ["local"] = false, selector = host.label }
  end
  return result
end
function M.listMachines() return machinesIn(rex.machinesRegistry()) end
function M.connectMachine(machine)
  local registry = rex.machinesRegistry()
  local current
  for _, choice in ipairs(machinesIn(registry)) do
    if choice.key == machine.key and choice["local"] == machine["local"] then
      current = choice
      break
    end
  end
  if not current then
    system.fail("Rex machine " .. machine.label .. " is no longer registered; choose another machine")
  end
  if current["local"] then
    current.hostId = rex.localHost().id
    return current
  end
  local identity = rex.remoteIdentity(current.selector)
  local found = false
  for _, entry in ipairs(registry.hosts) do
    if entry.host.id == current.key then
      for _, endpoint in ipairs(entry.host.endpoints) do
        if endpoint == identity.endpoint then
          found = true
          break
        end
      end
      break
    end
  end
  if not found then
    system.fail("Rex machine " .. current.label .. " resolved to an unexpected server; refusing to route remotely")
  end
  local actions = contracts.decode("RexActions", rex.remoteRex(current.selector, { "actions", "--json" }))
  local helper
  for _, action in ipairs(actions.actions) do
    if action.name == "worktrees_request" then
      helper = action
      break
    end
  end
  if not helper then
    system.fail(
      "rex-worktrees is not installed on "
        .. current.label
        .. ". Build and run rex-worktrees setup on that machine, then reload its Rex config."
    )
  end
  contracts.validate("RexHelperArgs", helper.args)
  current.hostId = identity.host_id
  return current
end
local function connectedRequest(host, command, body)
  local request = { version = 5, hostId = host.hostId }
  for key, value in pairs(body) do
    request[key] = value
  end
  local response
  if host["local"] then
    response = require("host").dispatchHost(request, command)
  else
    local raw = rex.remoteRex(
      host.selector,
      { "do", "worktrees_request", "--args", json.encode({ request = json.encode(request) }), "--json" }
    )
    local envelope = json.decode(raw)
    if type(envelope) ~= "string" then system.fail("Invalid Rex worktrees response envelope") end
    response = contracts.decode("Response", envelope)
  end
  if
    response.hostId ~= host.hostId
    or response.version ~= 5
    or (
      response.kind ~= body.kind
      and not (body.kind == "project" and response.kind == "project-missing" and response.path == body.path)
    )
  then
    system.fail(
      "Unexpected Rex host/protocol response from "
        .. host.label
        .. "; update rex-worktrees on that machine, run setup, and reload its Rex config"
    )
  end
  return response
end
local function request(host, command, body)
  if not host["local"] then
    local current = M.connectMachine(host)
    if current.hostId ~= host.hostId then
      system.fail("Rex host identity changed for " .. host.label .. "; reconnect before continuing")
    end
    host = current
  end
  return connectedRequest(host, command, body)
end
function M.inspectSessions(host, command) return request(host, command, { kind = "sessions" }) end
function M.connectAndDiscover(machine, command, context)
  return rex.withOperation(function()
    local host = M.connectMachine(machine)
    local body = { kind = "discover" }
    if context then body.context = context end
    local result = connectedRequest(host, command, body)
    result.host = host
    return result
  end)
end
function M.inspectProject(host, command, path)
  local result = request(host, command, { kind = "project", path = path })
  if result.kind == "project-missing" then system.fail("Project directory does not exist: " .. result.path) end
  return result
end
function M.inspectWorktrees(host, command, repo) return request(host, command, { kind = "worktrees", repo = repo }) end
function M.inspectRevision(host, command, repo, revision)
  return request(host, command, { kind = "revision", repo = repo, revision = revision }).revision
end
function M.review(host, command, input) return request(host, command, { kind = "plan", input = input }).plan end
function M.submit(host, command, input, reviewed)
  if reviewed.hostId ~= host.hostId then system.fail("Reviewed destination belongs to another host") end
  return request(host, command, { kind = "launch", input = input, reviewed = reviewed }).result
end
function M.sourceForClone(host, command, repo)
  return request(host, command, { kind = "clone-source", repo = repo }).source
end
function M.reviewClone(host, command, input) return request(host, command, { kind = "clone-plan", input = input }).plan end
function M.submitClone(host, command, input, reviewed)
  if reviewed.hostId ~= host.hostId then system.fail("Reviewed clone destination belongs to another host") end
  return request(host, command, { kind = "clone-launch", input = input, reviewed = reviewed }).result
end
return M
