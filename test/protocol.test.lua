return function()
  local s, contracts, worktrees = require("runtime"), require("contracts"), require("worktrees")
  local json = s.json
  local payload = { branch = json.null, worktrees = json.array(), value = false }
  local encoded = json.encode(payload)
  assert(encoded:find('"branch":null', 1, true))
  assert(encoded:find('"worktrees":%[%]'))
  local decoded = json.decode(encoded)
  assert(s.isNull(decoded.branch) and decoded.value == false)
  assert(json.encode(decoded.worktrees) == "[]")
  assert(not pcall(json.decode, "{bad"))
  for _, malformed in ipairs({
    "[1 2]",
    "[1,]",
    '{"a":1 "b":2}',
    '{"a":1,}',
    "/*comment*/null",
    '"\\x41"',
    '"\\uZZZZ"',
    '"line\nbreak"',
  }) do
    assert(not pcall(json.decode, malformed), malformed)
  end
  assert(json.decode('"\\uD83D\\uDE00"') == "😀")
  local request = { version = 5, hostId = "host", kind = "project", path = "/repo" }
  assert(contracts.validate("Request", request).hostId == "host")
  assert(not pcall(contracts.validate, "Request", { version = 5, kind = "project", path = "/repo" }))
  assert(not pcall(contracts.validate, "Request", { version = 4, hostId = "host", kind = "project", path = "/repo" }))
  local response = {
    version = 5,
    hostId = "host",
    kind = "worktrees",
    repository = { vcs = "git", path = "/repo", commonDir = "/repo/.git", name = "repo" },
    worktrees = json.array({
      { vcs = "git", path = "/repo", branch = json.null, head = "abc", bare = false, prunable = false },
    }),
    branches = json.array(),
    revisions = json.array(),
  }
  local wire = json.encode(json.encode(response))
  local roundTrip = contracts.decode("Response", json.decode(wire))
  assert(
    s.isNull(roundTrip.worktrees[1].branch)
      and json.encode(roundTrip.branches) == "[]"
      and json.encode(roundTrip.revisions) == "[]"
  )
  assert(
    not pcall(
      contracts.validate,
      "Response",
      { version = 4, hostId = "host", kind = "project-missing", path = "/repo" }
    )
  )
  assert(not pcall(contracts.validate, "Response", { version = 5, kind = "project-missing", path = "/repo" }))
  assert(not pcall(contracts.validate, "Request", { version = 5, hostId = "host", kind = "launch" }))
  assert(contracts.decode("ConfigEnvelope", '{"directory":"/rex","config":{"roots":[]}}').directory == "/rex")
  assert(not pcall(contracts.decode, "ConfigEnvelope", '{"directory":"/rex","config":{"roots":{}}}'))
  local discover =
    '{"version":5,"hostId":"host","kind":"discover","sessions":[],"clients":[],"projects":[],"cloneRoot":"/clones"}'
  assert(contracts.decode("Response", discover).cloneRoot == "/clones")
  assert(
    not pcall(
      contracts.decode,
      "Response",
      '{"version":5,"hostId":"host","kind":"discover","sessions":[],"clients":[],"projects":[]}'
    )
  )
  assert(
    not pcall(
      contracts.decode,
      "Response",
      '{"version":5,"hostId":"host","kind":"sessions","sessions":{},"clients":[]}'
    )
  )
  assert(
    not pcall(
      contracts.decode,
      "Response",
      '{"version":5,"hostId":"host","kind":"worktrees","repository":{"vcs":"git","path":"/repo","commonDir":"/repo/.git","name":"repo"},"worktrees":[{"vcs":"git","path":"/repo","branch":false,"head":"abc","bare":false,"prunable":false}],"branches":[],"revisions":[]}'
    )
  )
  local session = { kind = "existing", id = "session" }
  local plan = {
    vcs = "git",
    hostId = "host-a",
    worktreeRoot = "/trees",
    input = {
      vcs = "git",
      repo = "/repo",
      session = session,
      branch = "feature/topic",
      worktreeName = "task",
      name = "Feature",
    },
    path = "/trees/task",
    branch = "feature/topic",
    checkout = "create",
    base = { branch = "main", head = "abc" },
    action = "new-tab",
    nameRole = "tab",
    name = "Feature",
    label = "Create worktree & open",
  }
  local function copy(value)
    if type(value) ~= "table" then return value end
    local result = {}
    for k, v in pairs(value) do
      result[k] = copy(v)
    end
    return result
  end
  local changed = copy(plan)
  changed.warning = "informational"
  assert(worktrees.sameLaunchPlan(plan, changed))
  for _, mutate in ipairs({
    function(p) p.hostId = "other" end,
    function(p) p.worktreeRoot = "/other" end,
    function(p) p.input.directory = "/trees/task" end,
    function(p) p.input.session.id = "other" end,
    function(p) p.base.head = "def" end,
    function(p) p.checkout = "existing" end,
    function(p) p.input.worktreeName = "other" end,
    function(p) p.input.clientId = "other-client" end,
    function(p) p.action = "focus" end,
    function(p) p.target = { windowId = "window", blockId = "block" } end,
    function(p) p.name = "Changed" end,
  }) do
    changed = copy(plan)
    mutate(changed)
    assert(not worktrees.sameLaunchPlan(plan, changed))
  end
  local clone = {
    vcs = "git",
    hostId = "target",
    repo = "/target/repo",
    existing = false,
    label = "Clone & Open",
    input = {
      vcs = "git",
      source = {
        vcs = "git",
        sourceHostId = "source",
        url = "git@example.org:org/repo.git",
        branches = { "main", "topic" },
        branch = "main",
      },
      repo = "/target/repo",
      session = session,
      name = "Task",
      branch = "topic",
      branchMode = "existing",
    },
  }
  local external = copy(clone)
  external.input.source = { vcs = "git", url = "https://github.com/owner/repo" }
  external.input.branch, external.input.branchMode, external.input.checkout = nil, "default", "primary"
  local cloneRequest = { version = 5, hostId = "target", kind = "clone-plan", input = external.input }
  assert(contracts.validate("Request", cloneRequest).input.source.sourceHostId == nil)
  assert(contracts.validate("CloneTaskRequest", { plan = external }).plan.input.branch == nil)
  for _, mutate in ipairs({
    function(p) p.branch = "main" end,
    function(p) p.checkout = "worktree" end,
    function(p) p.checkout = nil end,
    function(p) p.directory = "/tree" end,
    function(p) p.worktreeName = "task" end,
  }) do
    local invalid = copy(cloneRequest)
    mutate(invalid.input)
    assert(not pcall(contracts.validate, "Request", invalid))
  end
  changed = copy(clone)
  changed.warning = "informational"
  assert(worktrees.sameClonePlan(clone, changed))
  for _, mutate in ipairs({
    function(p) p.input.branchMode = "create" end,
    function(p) p.input.checkout = "primary" end,
    function(p) p.input.directory = "/trees/task" end,
    function(p) p.input.source.sourceHostId = "target" end,
    function(p) p.repo = "/other" end,
  }) do
    changed = copy(clone)
    mutate(changed)
    assert(not worktrees.sameClonePlan(clone, changed))
  end
  local revision = { commitId = string.rep("a", 40), changeId = string.rep("b", 32), description = "base" }
  local jjPlan = {
    vcs = "jj",
    hostId = "target",
    input = {
      vcs = "jj",
      repo = "/source-workspace",
      session = session,
      name = "Task",
      worktreeName = "task",
      revision = "@-",
    },
    path = "/trees/task",
    checkout = "create",
    workspaceName = "task",
    base = revision,
    action = "new-tab",
    nameRole = "tab",
    name = "Task",
    label = "Create workspace & open",
  }
  changed = copy(jjPlan)
  changed.warning = "warning"
  assert(worktrees.sameLaunchPlan(jjPlan, changed))
  for _, mutate in ipairs({
    function(p) p.input.repo = "/another-workspace" end,
    function(p) p.base.commitId = string.rep("c", 40) end,
    function(p) p.base.changeId = string.rep("c", 32) end,
    function(p) p.workspaceName = "other" end,
  }) do
    changed = copy(jjPlan)
    mutate(changed)
    assert(not worktrees.sameLaunchPlan(jjPlan, changed))
  end
  local jjClone = {
    vcs = "jj",
    hostId = "target",
    repo = "/clone",
    existing = false,
    label = "Clone & Open",
    base = revision,
    input = {
      vcs = "jj",
      source = {
        vcs = "jj",
        url = "ssh://host/project",
        sourceHostId = "source",
        revisions = { { expression = "@-", label = "base", revision = revision } },
        revision = revision,
      },
      repo = "/clone",
      session = session,
      name = "Task",
      revision = revision.commitId,
    },
  }
  changed = copy(jjClone)
  changed.base.changeId = string.rep("c", 32)
  assert(not worktrees.sameClonePlan(jjClone, changed))
  changed = copy(jjClone)
  changed.input.revision = nil
  assert(not worktrees.sameClonePlan(jjClone, changed))
  assert(contracts.validate("CloneTaskRequest", { plan = jjClone }).plan.repo == "/clone")
  for _, name in ipairs({ "", " ", string.rep("a", 129), "line\nbreak", "\127" }) do
    assert(not pcall(contracts.validate, "SessionSelection", { kind = "new", name = name }))
  end
  assert(contracts.validate("SessionSelection", { kind = "new", name = string.rep("日", 43) }).kind == "new")
  assert(contracts.validate("SessionSelection", { kind = "new", name = string.rep("😀", 64) }).kind == "new")
  assert(not pcall(contracts.validate, "SessionSelection", { kind = "new", name = string.rep("😀", 65) }))
  assert(not pcall(contracts.validate, "SessionSelection", { kind = "new", name = "　 " }))
end
