local system = require("runtime")
local utf = require("lua-utf8")
local json = system.json
local schemas = {}
local function optional(t) return { optional = t } end
local function nullable(t) return { nullable = t } end
local function array(t) return { array = t } end
local function literal(...) return { literal = { ... } } end
local function union(...) return { union = { ... } } end
local function shape(fields) return { fields = fields } end
local S, B, N, A = "string", "boolean", "number", "any"
local function extend(a, b)
  local r = {}
  for k, v in pairs(a) do
    r[k] = v
  end
  for k, v in pairs(b) do
    r[k] = v
  end
  return r
end
local function check(spec, value)
  if spec == A then return value ~= nil end
  if type(spec) == "string" then
    if spec == "number" then
      return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
    end
    return type(value) == spec
  end
  if spec.predicate then return spec.predicate(value) end
  if spec.optional then return value == nil or check(spec.optional, value) end
  if spec.nullable then return system.isNull(value) or check(spec.nullable, value) end
  if spec.literal then
    for _, v in ipairs(spec.literal) do
      if value == v then return true end
    end
    return false
  end
  if spec.union then
    for _, v in ipairs(spec.union) do
      if check(v, value) then return true end
    end
    return false
  end
  if spec.array then
    if type(value) ~= "table" or system.isNull(value) then return false end
    local mt = getmetatable(value)
    if mt and mt.__jsontype == "object" then return false end
    local n = 0
    for k, v in pairs(value) do
      if type(k) ~= "number" or k < 1 or k % 1 ~= 0 or not check(spec.array, v) then return false end
      n = n + 1
    end
    return n == #value
  end
  if spec.fields then
    if type(value) ~= "table" or system.isNull(value) then return false end
    local mt = getmetatable(value)
    if mt and mt.__jsontype == "array" then return false end
    for k, v in pairs(spec.fields) do
      if not check(v, value[k]) then return false end
    end
    return true
  end
  return false
end
local function define(name, fields)
  schemas[name] = shape(fields)
  return schemas[name]
end
for _, name in ipairs({
  "SessionId",
  "ClientId",
  "BlockId",
}) do
  schemas[name] = S
end
local vcs = literal("git", "jj")
local revision = shape({ commitId = S, changeId = S, description = S })
local choice = shape({ expression = S, label = S, revision = revision })
local repo = shape({ vcs = vcs, path = S, commonDir = S, name = S })
local worktree = union(
  shape({ vcs = literal("git"), path = S, branch = nullable(S), head = S, bare = B, prunable = B }),
  shape({ vcs = literal("jj"), path = nullable(S), name = S, head = S, changeId = S, present = B })
)
local config = define("Config", {
  roots = optional(array(S)),
  projects = optional(array(union(S, shape({ path = S, worktreeRoot = optional(S) })))),
  worktreeRoot = optional(S),
})
define("ConfigEnvelope", { config = config, directory = S })
define("Association", { vcs = vcs, hostId = S, commonDir = S, path = S, sessionId = S, windowId = S, blockId = S })
local sessionName = {
  predicate = function(v)
    if type(v) ~= "string" or not utf.isvalid(v) then return false end
    local units, nonspace = 0, false
    for _, c in utf.codes(v) do
      if c < 32 or c == 127 or c == 0x2028 or c == 0x2029 then return false end
      units = units + (c > 0xFFFF and 2 or 1)
      if units > 128 then return false end
      if
        not (
          c == 0x20
          or c == 0xA0
          or c == 0x1680
          or c >= 0x2000 and c <= 0x200A
          or c == 0x202F
          or c == 0x205F
          or c == 0x3000
          or c == 0xFEFF
        )
      then
        nonspace = true
      end
    end
    return nonspace
  end,
}
local session =
  union(shape({ kind = literal("existing"), id = S }), shape({ kind = literal("new"), name = sessionName }))
schemas.SessionSelection = session
local target = shape({ id = S, label = S })
local gitSource =
  shape({ vcs = literal("git"), url = S, sourceHostId = S, branches = optional(array(S)), branch = optional(S) })
local jjSource = shape({
  vcs = literal("jj"),
  url = S,
  sourceHostId = S,
  revisions = optional(array(choice)),
  revision = optional(revision),
})
local source = union(gitSource, jjSource)
local commonInput = { repo = S, session = session, name = S, clientId = optional(S), directory = optional(S) }
local gitInput = shape(extend(commonInput, {
  vcs = literal("git"),
  branch = optional(S),
  worktreeName = optional(S),
  path = optional(S),
  additional = optional(B),
  split = optional(B),
}))
local jjInput = shape(extend(commonInput, {
  vcs = literal("jj"),
  revision = optional(S),
  worktreeName = optional(S),
  path = optional(S),
  additional = optional(B),
  split = optional(B),
}))
local input = union(gitInput, jjInput)
local cloneCommon =
  extend(commonInput, { worktreeName = optional(S), checkout = optional(literal("primary", "worktree")) })
local gitClone = shape(
  extend(
    cloneCommon,
    { vcs = literal("git"), source = gitSource, branch = S, branchMode = literal("existing", "create") }
  )
)
local jjClone = shape(extend(cloneCommon, { vcs = literal("jj"), source = jjSource, revision = optional(S) }))
local cloneInput = union(gitClone, jjClone)
local planFields = {
  hostId = S,
  clientId = optional(S),
  path = S,
  worktreeRoot = optional(S),
  action = literal("focus", "new-tab", "split"),
  target = optional(shape({ windowId = S, blockId = S })),
  nameRole = literal("tab", "pane", "none"),
  name = optional(S),
  label = S,
  detail = optional(S),
  warning = optional(S),
}
local head = shape({ branch = nullable(S), head = S })
local plan = union(
  shape(extend(planFields, {
    vcs = literal("git"),
    input = gitInput,
    branch = nullable(S),
    checkout = literal("existing", "attach", "create"),
    base = optional(head),
  })),
  shape(
    extend(
      planFields,
      {
        vcs = literal("jj"),
        input = jjInput,
        checkout = literal("existing", "create"),
        workspaceName = S,
        base = optional(revision),
      }
    )
  )
)
local cloneFields = {
  hostId = S,
  clientId = optional(S),
  repo = S,
  existing = B,
  commonDir = optional(S),
  label = S,
  detail = optional(S),
  warning = optional(S),
}
local clonePlan = union(
  shape(extend(cloneFields, { vcs = literal("git"), input = gitClone, base = optional(S) })),
  shape(extend(cloneFields, { vcs = literal("jj"), input = jjClone, base = optional(revision) }))
)
local settings = { rexBinDir = optional(S), rexLocalEndpoint = optional(S) }
define("CloneTaskRequest", extend(settings, { plan = clonePlan }))
local taskFields =
  extend(settings, { repo = S, hostId = S, path = S, commonDir = S, session = session, worktreeRoot = optional(S) })
schemas.TaskRequest = union(
  shape(extend(taskFields, {
    vcs = literal("git"),
    branch = optional(S),
    worktreeName = optional(S),
    base = optional(S),
    checkout = optional(literal("attach", "existing")),
  })),
  shape(
    extend(
      taskFields,
      { vcs = literal("jj"), checkout = literal("existing", "create"), workspaceName = S, base = optional(revision) }
    )
  )
)
local launchResult = shape({
  hostId = S,
  sessionId = S,
  windowId = S,
  blockId = S,
  path = S,
  pending = B,
  action = literal("focus", "new-tab", "split"),
  warning = optional(S),
})
local cloneResult = shape({
  hostId = S,
  sessionId = S,
  windowId = S,
  blockId = S,
  repo = S,
  pending = literal(true),
  warning = optional(S),
})
local req = {
  discover = { context = optional(S) },
  sessions = {},
  ["clone-source"] = { repo = S },
  project = { path = S },
  worktrees = { repo = S },
  revision = { repo = S, revision = S },
  plan = { input = input },
  ["clone-plan"] = { input = cloneInput },
  ["clone-launch"] = { input = cloneInput, reviewed = clonePlan },
  launch = { input = input, reviewed = plan },
}
local res = {
  discover = {
    sessions = array(target),
    clients = array(target),
    projects = array(repo),
    roots = optional(array(S)),
    cloneRoot = S,
    checkout = optional(repo),
  },
  sessions = { sessions = array(target), clients = array(target) },
  project = {
    project = repo,
    checkout = repo,
    worktrees = array(worktree),
    branches = array(S),
    revisions = array(choice),
    worktreeRoot = optional(S),
  },
  ["project-missing"] = { path = S },
  ["clone-source"] = { source = source },
  worktrees = {
    repository = repo,
    worktrees = array(worktree),
    branches = array(S),
    revisions = array(choice),
    worktreeRoot = optional(S),
  },
  revision = { revision = revision },
  plan = { plan = plan },
  ["clone-plan"] = { plan = clonePlan },
  ["clone-launch"] = { result = cloneResult },
  launch = { result = launchResult },
}
local function variants(entries)
  local list = {}
  for kind, fields in pairs(entries) do
    list[#list + 1] = shape(extend(fields, { version = literal(5), hostId = S, kind = literal(kind) }))
  end
  return { union = list }
end
schemas.Request = variants(req)
schemas.Response = variants(res)
local chooserField = literal("project", "machine", "session", "destination", "branch", "checkoutName", "mode")
define("ChooserRequest", {
  op = literal("start", "edit", "accept", "cancel", "submit", "confirm"),
  state = optional(S),
  origin = optional(shape({ sessionId = optional(S), blockId = optional(S), clientId = optional(S), server = optional(S) })),
  context = optional(S),
  machine = optional(S),
  field = optional(chooserField),
  id = optional(S),
  text = optional(S),
})
define("ChooserState", {
  draft = shape({ mode = literal("auto", "new-tab", "split") }),
  origin = shape({ sessionId = optional(S), blockId = optional(S), clientId = optional(S), server = optional(S) }),
  originMachine = optional(S),
  projects = array(A),
  sessions = array(A),
  cloneRoot = S,
  editor = optional(shape({
    field = chooserField, kind = literal("pick", "input"), title = S,
    choices = array(shape({ id = S, value = A, title = S, detail = optional(S) })), allowOther = B,
  })),
  confirmation = optional(shape({ warning = S })),
  blocked = optional(B), done = optional(B), error = optional(S), notice = optional(S),
})
define("ChooserResponse", {
  state = optional(S),
  rows = array(shape({ id = chooserField, label = S, value = S, detail = optional(S),
    disabled = optional(B), isReadOnly = optional(B) })),
  submitLabel = S, submitDisabled = B, error = optional(S), notice = optional(S),
  editor = optional(shape({
    kind = literal("pick", "input"), title = S,
    items = array(shape({ id = S, title = S, subtitle = optional(S), detail = optional(S) })),
    allowOther = B, value = optional(S),
  })),
  confirmation = optional(shape({ title = S, detail = S })),
  done = optional(B), result = optional(union(launchResult, cloneResult)),
})
define("RexIdentity", { host_id = S, endpoint = S, principal = shape({ transport = S }) })
define("RexSessions", { sessions = array(shape({ session_id = S, label = S })) })
define("RexCreated", { window_id = S, block_ids = array(S) })
define("RexSplitCreated", { block_ids = array(S) })
define("RexSessionCreated", { session_id = S, initial_windows = array(schemas.RexCreated) })
define(
  "RexClients",
  {
    clients = array(
      shape({ client_id = S, info = optional(shape({ kind = S, label = optional(S) })), connection_state = optional(S) })
    ),
  }
)
define(
  "RexBlocks",
  { blocks = array(shape({ block_id = S, host_id = optional(S), placement = S, window_id = optional(nullable(S)) })) }
)
define("RexTerminalSize", { columns = N, rows = N })
define("RexLayer", { layer_id = nullable(S), block_ids = nullable(array(nullable(S))), revision = N })
define("RexDirectory", { pwd = optional(S) })
define(
  "RexRegistry",
  {
    home = shape({ label = S, endpoint = S, this_machine = B }),
    hosts = array(shape({ host = shape({ id = S, label = S, endpoints = array(S) }) })),
  }
)
define(
  "RexProcess",
  { last_exit = nullable(shape({ exit_code = N })), foreground = optional(nullable(shape({ cwd = optional(S) }))) }
)
define("RexActions", { actions = array(shape({ name = S, args = optional(A) })) })
define("RexHelperArgs", { properties = shape({ request = shape({ type = literal("string") }) }) })
define("RexConfigCheck", { path = S, exists = B, diagnostics = array(A) })
define("RexTaskIdentity", { REX_SESSION = S, REX_BLOCK = S })
local rect = { predicate = function(v) return check(array(N), v) and #v == 4 end }
local layout = shape({})
layout.fields = {
  rect = rect,
  block_id = optional(nullable(S)),
  split = optional(nullable(shape({ before = layout, after = layout }))),
}
define("RexView", {
  active_window_id = nullable(S),
  windows = array(shape({
    window_id = S,
    focused_block_id = optional(nullable(S)),
    zoomed_block_id = optional(nullable(S)),
    layers = array(
      shape({
        layout = nullable(layout),
        blocks = array(shape({ block_id = S, flavor = S, owner = optional(nullable(S)) })),
      })
    ),
  })),
})
local function validate(name, value)
  local schema = schemas[name]
  if not schema then system.fail("Unknown contract: " .. tostring(name)) end
  if not check(schema, value) then system.fail("Invalid " .. name) end
  if
    name == "RexTerminalSize"
    and (value.columns <= 0 or value.rows <= 0 or value.columns % 1 ~= 0 or value.rows % 1 ~= 0)
  then
    system.fail("Invalid RexTerminalSize")
  end
  return value
end
return {
  validate = validate,
  decode = function(name, text) return validate(name, json.decode(text)) end,
}
