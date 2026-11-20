return function(root)
  local s, rex = require("runtime"), require("rex")
  local posix = require("posix.stdlib")
  local dir, log = root .. "/rex-bin", root .. "/rex-calls"
  s.fs.makeDirectory(dir, { recursive = true })
  local executable = dir .. "/rex"
  s.fs.writeFileString(
    executable,
    [=[#!/bin/sh
for arg in "$@"; do last="$arg"; done
printf '%s\n' "$last" >> "$REX_TEST_LOG"
case " $* " in
  *' -S Remote '*' whoami '*) printf '{"host_id":"%s","endpoint":"%s","principal":{"transport":"unix"}}\n' "${REX_TEST_REMOTE_HOST:-remote-host}" "${REX_TEST_REMOTE_ENDPOINT:-unix:///remote-one}" ;;
  *' hosts list '*) printf '{"home":{"label":"Local","endpoint":"unix:///fixture.sock","this_machine":true},"hosts":[{"host":{"id":"remote-id","label":"Remote","endpoints":["%s"]}}]}\n' "${REX_TEST_REGISTERED_ENDPOINT:-unix:///remote-one}" ;;
  *' actions '*) echo '{"actions":[{"name":"worktrees_request","args":{"properties":{"request":{"type":"string"}}}}]}' ;;
  *' whoami '*) echo '{"host_id":"fixture-host","endpoint":"unix:///fixture.sock","principal":{"transport":"unix"}}' ;;
  *' session.list_blocks '*) printf '{"blocks":[{"block_id":"block","host_id":"%s","placement":"%s","window_id":"%s"}]}\n' "${REX_TEST_BLOCK_HOST:-fixture-host}" "${REX_TEST_PLACEMENT:-placed}" "${REX_TEST_WINDOW:-window}" ;;
  *' ls '*) echo '{"sessions":[{"session_id":"session","label":"Same label"}]}' ;;
  *' session.focus_block '*) echo '{}' ;;
  *' process '*)
    if [ "$REX_TEST_PROCESS_ERROR" = missing ]; then echo 'Error: block target "block" not found' >&2; exit 3; fi
    if [ "$REX_TEST_PROCESS_ERROR" = denied ]; then echo 'permission denied' >&2; exit 3; fi
    if [ "$REX_TEST_NO_CWD" = 1 ]; then echo '{"last_exit":null,"foreground":{}}'; exit 0; fi
    printf '{"last_exit":%s,"foreground":{"cwd":"%s"}}\n' "${REX_TEST_EXIT:-null}" "${REX_TEST_CWD:-/projects/current}" ;;
  *' pwd '*) printf '{"pwd":"%s"}\n' "${REX_TEST_PWD:-file://foreign.invalid/projects/current}" ;;
  *' client.list '*) echo '{"clients":[]}' ;;
  *' session.view '*) echo '{"active_window_id":"window","windows":[{"window_id":"window","focused_block_id":"block","zoomed_block_id":null,"layers":[{"layout":{"rect":[0,0,1,1],"block_id":"block"},"blocks":[{"block_id":"block","flavor":"com.superlogical.terminal.shell"}]}]}]}' ;;
  *' session.new_split '*) echo '{"block_ids":["new-pane"]}' ;;
  *' session.create '*) echo '{"session_id":"created","initial_windows":[{"window_id":"new-window","block_ids":["new-block"]}]}' ;;
  *) echo "unexpected rex call: $*" >&2; exit 1 ;;
esac
]=]
  )
  s.fs.chmod(executable, 493)
  assert(posix.setenv("REX_BIN_DIR", dir, true))
  assert(posix.setenv("REX_TEST_LOG", log, true))
  assert(posix.setenv("REX_WORKTREES_LOCAL_ENDPOINT", "unix:///fixture.sock", true))
  local client = require("client")
  local remote = { key = "remote-id", label = "Remote", ["local"] = false, selector = "Remote" }
  assert(client.connectMachine(remote).hostId == "remote-host")
  assert(posix.setenv("REX_TEST_REMOTE_ENDPOINT", "unix:///remote-two", true))
  assert(posix.setenv("REX_TEST_REMOTE_HOST", "remote-host-2", true))
  assert(not pcall(client.connectMachine, remote))
  assert(posix.setenv("REX_TEST_REGISTERED_ENDPOINT", "unix:///remote-two", true))
  assert(client.connectMachine(remote).hostId == "remote-host-2")
  assert(posix.setenv("REX_TEST_REMOTE_ENDPOINT", nil))
  assert(posix.setenv("REX_TEST_REGISTERED_ENDPOINT", nil))
  assert(posix.setenv("REX_TEST_REMOTE_HOST", nil))
  assert(rex.originDirectory("session", "block") == "/projects/current")
  assert(posix.setenv("REX_TEST_PWD", "file://localhost/projects/reported", true))
  assert(rex.originDirectory("session", "block") == "/projects/reported")
  assert(posix.setenv("REX_TEST_BLOCK_HOST", "remote-host", true))
  local logBefore = s.fs.readFileString(log)
  assert(rex.originDirectory("session", "block") == nil)
  local logAfter = s.fs.readFileString(log):sub(#logBefore + 1)
  assert(not logAfter:find("pwd", 1, true) and not logAfter:find("process", 1, true))
  assert(posix.setenv("REX_TEST_BLOCK_HOST", nil))
  assert(posix.setenv("REX_TEST_PLACEMENT", "detached", true))
  assert(rex.originDirectory("session", "block") == nil)
  assert(posix.setenv("REX_TEST_PLACEMENT", nil))
  assert(posix.setenv("REX_TEST_PWD", nil))
  local split = rex.openTerminal(
    { kind = "existing", id = "session" },
    "Split",
    "/repo",
    { "/bin/sh" },
    { windowId = "anchor-window", blockId = "anchor-pane" }
  )
  assert(split.sessionId == "session" and split.windowId == "anchor-window" and split.blockId == "new-pane")
  local created = rex.openTerminal({ kind = "new", name = "Same label" }, "Task", "/repo", { "/bin/sh" })
  assert(created.sessionId == "created" and created.windowId == "new-window" and created.blockId == "new-block")
  local calls = s.fs.readFileString(log)
  local found = false
  for line in calls:gmatch("[^\n]+") do
    local ok, value = pcall(s.json.decode, line)
    if ok and type(value) == "table" and value.initial_windows then
      found = true
      assert(value.label == "Same label" and #value.initial_windows == 1)
      assert(value.initial_windows[1].layout.block.options.cwd == "/repo")
    end
  end
  assert(posix.setenv("REX_SESSION", "session", true))
  assert(posix.setenv("REX_BLOCK", "block", true))
  assert(not pcall(rex.taskContext, { kind = "existing", id = "wrong-session" }, {}, "fixture-host"))
  assert(not pcall(rex.taskContext, { kind = "existing", id = "session" }, {}, "wrong-host"))
  local context = rex.taskContext({ kind = "existing", id = "session" }, {}, "fixture-host")
  assert(context.sessionId == "session" and context.blockId == "block")
  assert(posix.setenv("REX_SESSION", nil))
  assert(posix.setenv("REX_BLOCK", nil))
  assert(found)
  local worktrees = require("worktrees")
  local repo = root .. "/review-repo"
  s.fs.makeDirectory(repo, { recursive = true })
  local function git(...)
    local result = s.capture({ "git", "-C", repo, ... })
    assert(result.ok, result.stderr)
    return result.stdout
  end
  git("init", "-b", "main")
  git("config", "user.name", "Rex Tests")
  git("config", "user.email", "rex@example.test")
  s.fs.writeFileString(repo .. "/tracked", "base\n")
  git("add", "tracked")
  git("commit", "-m", "base")
  local redirected = {
    vcs = "git",
    repo = repo,
    branch = "main",
    directory = root .. "/not-the-existing-worktree",
    name = "Task",
    session = { kind = "existing", id = "session" },
  }
  for _ = 1, 2 do
    assert(not pcall(worktrees.planLaunch, redirected, "fixture-host"))
  end
  assert(not s.fs.exists(redirected.directory))
  local state = require("state")
  state.saveAssociation({
    vcs = "git",
    hostId = "fixture-host",
    commonDir = repo .. "/.git",
    path = repo,
    sessionId = "session",
    windowId = "window",
    blockId = "block",
  })
  assert(posix.setenv("REX_TEST_CWD", repo, true))
  assert(posix.setenv("REX_TEST_PWD", "file://localhost/stale", true))
  local existingInput =
    { vcs = "git", repo = repo, path = repo, name = "Task", session = { kind = "existing", id = "session" } }
  local reuse = worktrees.planLaunch(existingInput, "fixture-host")
  assert(reuse.action == "focus" and reuse.target.blockId == "block" and reuse.target.windowId == "window")
  assert(posix.setenv("REX_TEST_PWD", repo, true))
  assert(posix.setenv("REX_TEST_CWD", root, true))
  assert(worktrees.planLaunch(existingInput, "fixture-host").action == "new-tab")
  assert(posix.setenv("REX_TEST_CWD", repo, true))
  assert(posix.setenv("REX_TEST_NO_CWD", "1", true))
  assert(worktrees.planLaunch(existingInput, "fixture-host").action == "new-tab")
  assert(posix.setenv("REX_TEST_NO_CWD", nil))
  local splitInput = {
    vcs = "git",
    repo = repo,
    path = repo,
    name = "Pane",
    session = { kind = "existing", id = "session" },
    split = true,
  }
  local splitReview = worktrees.planLaunch(splitInput, "fixture-host")
  assert(splitReview.action == "split" and splitReview.nameRole == "pane" and splitReview.target.blockId == "block")
  local extraInput = {
    vcs = "git",
    repo = repo,
    path = repo,
    name = "Extra",
    session = { kind = "existing", id = "session" },
    additional = true,
  }
  assert(worktrees.planLaunch(extraInput, "fixture-host").action == "new-tab")
  assert(posix.setenv("REX_TEST_WINDOW", "moved-window", true))
  assert(worktrees.planLaunch(existingInput, "fixture-host").action == "new-tab")
  assert(posix.setenv("REX_TEST_WINDOW", nil))
  assert(posix.setenv("REX_TEST_EXIT", '{"exit_code":0}', true))
  assert(worktrees.planLaunch(existingInput, "fixture-host").action == "new-tab")
  assert(posix.setenv("REX_TEST_EXIT", nil))
  assert(posix.setenv("REX_TEST_PROCESS_ERROR", "missing", true))
  assert(worktrees.planLaunch(existingInput, "fixture-host").action == "new-tab")
  assert(posix.setenv("REX_TEST_PROCESS_ERROR", "denied", true))
  local processOk, processError = pcall(worktrees.planLaunch, existingInput, "fixture-host")
  assert(not processOk and s.message(processError):find("permission denied", 1, true))
  assert(posix.setenv("REX_TEST_PROCESS_ERROR", nil))
  local associationDir = root .. "/state/rex-worktrees/associations"
  s.fs.writeFileString(associationDir .. "/invalid.json", "{broken")
  assert(worktrees.planLaunch(existingInput, "fixture-host").action == "focus")
  s.fs.remove(associationDir .. "/invalid.json")
  s.fs.rename(associationDir, associationDir .. "-saved")
  s.fs.writeFileString(associationDir, "not a directory")
  local warned = worktrees.planLaunch(existingInput, "fixture-host")
  assert(warned.action == "new-tab" and type(warned.warning) == "string" and warned.warning ~= "")
  s.fs.remove(associationDir)
  s.fs.rename(associationDir .. "-saved", associationDir)
  assert(posix.setenv("REX_TEST_PLACEMENT", "detached", true))
  assert(worktrees.planLaunch(existingInput, "fixture-host").action == "new-tab")
  assert(posix.setenv("REX_TEST_PLACEMENT", nil))
  assert(posix.setenv("REX_TEST_CWD", nil))
  assert(posix.setenv("REX_TEST_PWD", nil))
  local host = require("host")
  local reply = host.hostRequest(
    s.json.encode({ version = 5, hostId = "fixture-host", kind = "project", path = root .. "/missing-project" }),
    { "/usr/bin/false" }
  )
  assert(
    reply.version == 5
      and reply.hostId == "fixture-host"
      and reply.kind == "project-missing"
      and reply.path == root .. "/missing-project"
  )
  assert(
    not pcall(
      host.hostRequest,
      s.json.encode({ version = 5, hostId = "wrong-host", kind = "sessions" }),
      { "/usr/bin/false" }
    )
  )
  local inventory = host.hostRequest(
    s.json.encode({ version = 5, hostId = "fixture-host", kind = "worktrees", repo = repo }),
    { "/usr/bin/false" }
  )
  assert(inventory.worktrees[1].path == repo and inventory.worktrees[1].branch == "main")
  assert(s.json.encode(inventory.revisions) == "[]")
  local input =
    { vcs = "git", repo = repo, path = repo, name = "Task", session = { kind = "new", name = "Same label" } }
  local branchInput = {
    vcs = "git",
    repo = repo,
    branch = "reviewed-feature",
    name = "Branch task",
    session = { kind = "new", name = "Same label" },
  }
  local branchReview = worktrees.planLaunch(branchInput, "fixture-host")
  s.fs.writeFileString(repo .. "/advance", "advanced")
  git("add", "advance")
  git("commit", "-m", "advance")
  local beforeStale = s.fs.readFileString(log)
  assert(not pcall(worktrees.launch, branchInput, { "/usr/bin/true" }, branchReview, "fixture-host"))
  assert(not s.fs.readFileString(log):sub(#beforeStale + 1):find('"initial_windows"', 1, true))
  assert(git("branch", "--list", "reviewed-feature") == "")
  local reviewed = worktrees.planLaunch(input, "fixture-host")
  local prior = s.fs.readFileString(log)
  assert(
    not pcall(
      worktrees.launch,
      { vcs = "git", repo = repo, path = repo, name = "Task", session = { kind = "new", name = "Changed" } },
      { "/usr/bin/true" },
      reviewed,
      "fixture-host"
    )
  )
  assert(not pcall(worktrees.launch, input, { "/usr/bin/true" }, reviewed, "wrong-host"))
  assert(not s.fs.readFileString(log):sub(#prior + 1):find('"initial_windows"', 1, true))
  local launched = worktrees.launch(input, { "/usr/bin/true" }, reviewed, "fixture-host")
  assert(launched.sessionId == "created" and launched.pending and launched.path == repo)
  local newcalls = s.fs.readFileString(log):sub(#prior + 1)
  local create
  for line in newcalls:gmatch("[^\n]+") do
    local ok, value = pcall(s.json.decode, line)
    if ok and type(value) == "table" and value.initial_windows then
      assert(not create)
      create = value
    end
  end
  assert(create and create.label == "Same label" and #create.initial_windows == 1)
  local args = create.initial_windows[1].layout.block.options.command
  local task
  for i, value in ipairs(args) do
    if value == "task" then task = s.json.decode(args[i + 1]) end
  end
  assert(task and task.session.kind == "new" and task.session.name == "Same label")
  assert(task.hostId == "fixture-host" and task.commonDir == repo .. "/.git" and task.path == repo)
  assert(task.rexBinDir == dir and task.rexLocalEndpoint == "unix:///fixture.sock")
  local cloneInput = {
    vcs = "git",
    repo = root .. "/new-clone",
    name = "Clone task",
    branch = "main",
    branchMode = "existing",
    session = { kind = "new", name = "Same label" },
    source = { vcs = "git", url = repo, sourceHostId = "fixture-host", branches = { "main" }, branch = "main" },
  }
  local cloneReview = worktrees.planClone(cloneInput, "fixture-host")
  local clonePrior = s.fs.readFileString(log)
  local altered = {
    vcs = "git",
    repo = cloneInput.repo,
    name = cloneInput.name,
    branch = "main",
    branchMode = "existing",
    source = cloneInput.source,
    session = { kind = "new", name = "Changed" },
  }
  assert(not pcall(worktrees.launchClone, altered, { "/usr/bin/true" }, cloneReview, "fixture-host"))
  assert(not s.fs.readFileString(log):sub(#clonePrior + 1):find('"initial_windows"', 1, true))
  local cloneLaunched = worktrees.launchClone(cloneInput, { "/usr/bin/true" }, cloneReview, "fixture-host")
  assert(cloneLaunched.sessionId == "created" and cloneLaunched.pending and cloneLaunched.repo == cloneInput.repo)
  local cloneCreate
  for line in s.fs.readFileString(log):sub(#clonePrior + 1):gmatch("[^\n]+") do
    local ok, value = pcall(s.json.decode, line)
    if ok and type(value) == "table" and value.initial_windows then
      assert(not cloneCreate)
      cloneCreate = value
    end
  end
  assert(cloneCreate and cloneCreate.label == "Same label")
  local cloneCommand = cloneCreate.initial_windows[1].layout.block.options.command
  local cloneTask
  for i, value in ipairs(cloneCommand) do
    if value == "clone-task" then cloneTask = s.json.decode(cloneCommand[i + 1]) end
  end
  assert(cloneTask and cloneTask.plan.repo == cloneInput.repo and cloneTask.plan.input.session.name == "Same label")
  assert(posix.setenv("REX_SESSION", "session", true))
  assert(posix.setenv("REX_BLOCK", "block", true))
  task.session = { kind = "existing", id = "another-session" }
  assert(not pcall(worktrees.task, task))
  task.session = { kind = "existing", id = "session" }
  task.commonDir = root .. "/replacement-metadata"
  assert(not pcall(worktrees.task, task))
  cloneTask.plan.input.session = { kind = "existing", id = "another-session" }
  assert(not pcall(worktrees.cloneTask, cloneTask))
  assert(not s.fs.exists(cloneInput.repo))
  assert(posix.setenv("REX_SESSION", nil))
  assert(posix.setenv("REX_BLOCK", nil))
  assert(posix.setenv("REX_BIN_DIR", nil))
  assert(posix.setenv("REX_TEST_LOG", nil))
  assert(posix.setenv("REX_WORKTREES_LOCAL_ENDPOINT", nil))
end
