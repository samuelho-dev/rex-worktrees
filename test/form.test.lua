return function()
  local ui, s = require("ui"), require("runtime")
  local rows = {
    { id = "project", label = "Project", value = "atelier" },
    { id = "machine", label = "Machine", value = "Homelab", detail = "Host ID: host-remote" },
    { id = "session", label = "Session", value = "session-123" },
    { id = "destination", label = "Worktree", value = "feature", detail = "Destination details" },
    { id = "branch", label = "Branch", value = "feature" },
    { id = "checkoutName", label = "Directory", value = "/projects/atelier.worktrees/feature" },
    { id = "mode", label = "Mode", value = "Auto" },
  }
  local view = { rows = rows, submitLabel = "Create worktree & open" }
  local function lines(frame)
    local out = {}
    for line in (frame .. "\r\n"):gmatch("(.-)\r\n") do
      out[#out + 1] = line
    end
    return out
  end
  for _, dimensions in ipairs({ { 80, 16 }, { 82, 18 } }) do
    local rendered = lines(ui.renderFormFrame(view, "machine", dimensions[1], dimensions[2], false))
    assert(#rendered == dimensions[2])
    assert(rendered[1]:find("REX / WORKTREES", 1, true))
    for i, label in ipairs({ "PROJECT", "MACHINE", "SESSION", "WORKTREE", "BRANCH", "DIRECTORY", "MODE" }) do
      assert(rendered[i + 2]:find(label, 1, true))
    end
    for _, line in ipairs(rendered) do
      assert(s.unicode.width(line) == dimensions[1])
    end
    assert(rendered[#rendered]:find("Tab next", 1, true))
  end
  assert(ui.renderFormFrame(view, "submit", 80, 16, false):find("Destination details", 1, true))
  local malicious = "\27[2J\27]0;hijack\7\226\128\174VISIBLE\nNEXT"
  local frame = ui.renderFormFrame({ rows = rows, submitLabel = "Open", error = malicious }, "machine", 60, 20, false)
  assert(not frame:find("\27", 1, true) and not frame:find("\7", 1, true) and not frame:find("\226\128\174", 1, true))
  assert(frame:find("NEXT", 1, true))
  local longError = "Cannot open " .. string.rep("details ", 60) .. "END OF ERROR"
  local first =
    lines(ui.renderFormFrame({ rows = rows, submitLabel = "Open", error = longError }, "project", 80, 16, false))
  local last = lines(
    ui.renderFormFrame(
      { rows = rows, submitLabel = "Open", error = longError },
      "mode",
      80,
      16,
      false,
      { detailOffset = 999 }
    )
  )
  assert(table.concat(first, " "):find("PgDn", 1, true))
  assert(table.concat(last, " "):find("END OF ERROR", 1, true))
  assert(first[5]:find("SESSION", 1, true) and last[9]:find("MODE", 1, true))
  local choices = { { value = "one", title = "One" }, { value = "feature", title = "feature" } }
  local typed = ui.advanceInputChoice({ text = "", selected = nil }, "f", "feature", choices)
  assert(typed._tag == "NextFrame" and typed.state.text == "feature" and typed.state.selected == nil)
  local submitted = ui.advanceInputChoice(typed.state, "enter", "", choices)
  assert(submitted._tag == "Submit" and submitted.value.kind == "typed" and submitted.value.text == "feature")
  local picked = ui.advanceInputChoice(typed.state, "down", "", choices)
  submitted = ui.advanceInputChoice(picked.state, "enter", "", choices)
  assert(submitted._tag == "Submit" and submitted.value.kind == "selected" and submitted.value.value == "feature")
  local deleted = ui.advanceInputChoice({ text = "a👩‍💻" }, "backspace", "", choices)
  assert(deleted.state.text == "a")
  assert(ui.advanceInputChoice({ text = "" }, "paste", "\0", choices)._tag == "Beep")
  assert(ui.advanceInputChoice({ text = "custom" }, "enter", "", choices, true)._tag == "Beep")
  local exact = ui.advanceInputChoice({ text = "", selected = 1 }, "ctrl_s", "", choices, true)
  assert(exact._tag == "Submit" and exact.value.kind == "selected" and exact.value.value == "feature")
  assert(ui.advanceInputChoice({ text = "missing" }, "ctrl_s", "", choices, true)._tag == "Beep")
  assert(ui.advanceInputChoice(typed.state, "alt_x", "", choices)._tag == "Beep")
  assert(ui.advanceInputChoice(typed.state, "ctrl_d", "", choices)._tag == "Beep")
  local editor = ui.renderInputChoice(
    { text = "", selected = 0 },
    { { value = "base", title = "main\27]2;hijack\7\nnext", description = "commit\27[2J\nsecond" } },
    60,
    false
  )
  assert(not table.concat(editor):find("\27", 1, true) and not table.concat(editor):find("\7", 1, true))
  for _, line in ipairs(editor) do
    assert(s.unicode.width(line) <= 60)
  end
  local items = {}
  for i = 0, 19 do
    items[#items + 1] = { value = i, title = "Choice " .. i }
  end
  for _, selectedIndex in ipairs({ 0, 19 }) do
    local dock = ui.renderInputChoice({ text = "", selected = selectedIndex }, items, 80, false)
    local rendered =
      lines(ui.renderFormFrame(view, "project", 80, 16, false, { editor = { title = "Project", lines = dock } }))
    assert(#rendered == 16 and rendered[11]:find("Type new value", 1, true))
    for i = 12, 14 do
      assert(rendered[i]:find("Choice", 1, true))
    end
    assert(table.concat(rendered, " "):find("› Choice " .. selectedIndex, 1, true))
    assert(rendered[16]:find("Esc back", 1, true))
  end
  local unsafeRows = {}
  for i, row in ipairs(rows) do
    unsafeRows[i] = { id = row.id, label = row.label, value = malicious, detail = malicious }
  end
  local unsafeFrame = ui.renderFormFrame(
    { rows = unsafeRows, error = malicious },
    "machine",
    60,
    20,
    false,
    { editor = { title = malicious, lines = editor } }
  )
  assert(
    not unsafeFrame:find("\27", 1, true)
      and not unsafeFrame:find("\7", 1, true)
      and not unsafeFrame:find("\226\128\174", 1, true)
  )
  assert(ui.renderFormFrame(view, "project", 80, 8, false):find("Resize", 1, true))
  assert(ui.advanceInputChoice({ text = "" }, "paste", "\127", choices)._tag == "Beep")
  assert(ui.advanceInputChoice({ text = "" }, "paste", "\194\128", choices).state.text == "\194\128")
  assert(ui.advanceInputChoice(picked.state, "paste", "é/木", choices).state.text == "featureé/木")
  assert(ui.advanceInputChoice(typed.state, "ctrl_u", "", choices).state.text == "")
  local escaped = ui.advanceInputChoice(typed.state, "escape", "", choices)
  assert(escaped._tag == "Submit" and (escaped.value == nil or s.isNull(escaped.value)))
  local host = { key = "local", selector = "", label = "local", ["local"] = true, hostId = "host" }
  local repo = { vcs = "git", path = "/projects/alpha", commonDir = "/git/alpha", name = "alpha" }
  local draft = {
    machine = host,
    host = host,
    project = repo,
    projectChoice = { name = "alpha", source = { machineKey = "local", hostId = "host", repository = repo } },
    session = { kind = "existing", id = "session" },
    mode = "split",
    isCreating = true,
    directory = "/custom/task",
  }
  draft = ui.changeDestination(draft, { branch = "feature/topic", label = "feature/topic" }, "task-name")
  local input = ui.inputFor(draft)
  assert(
    input.branch == "feature/topic"
      and input.worktreeName == "task-name"
      and input.directory == "/custom/task"
      and input.split
  )
  local selected = ui.selectWorktree(
    draft,
    { vcs = "git", path = repo.path, branch = "main", head = "abc", bare = false, prunable = false }
  )
  input = ui.inputFor(selected)
  assert(input.path == repo.path and input.branch == nil and input.worktreeName == nil and selected.directory == nil)
  local gitCloneDraft = {
    host = host,
    projectChoice = { name = "alpha" },
    session = { kind = "new", name = "Same label" },
    clone = {
      vcs = "git",
      url = "https://example.com/alpha.git",
      sourceHostId = "host",
      branches = { "main", "feature/pushed" },
      branch = "main",
      repo = "/target/alpha",
    },
    destination = { branch = "feature/pushed", label = "feature/pushed" },
    isCreating = true,
    directory = "/custom/feature",
    worktreeName = "alpha-feature",
  }
  assert(ui.inputFor(gitCloneDraft) == nil)
  local gitClone = ui.cloneInputFor(gitCloneDraft)
  assert(
    gitClone.repo == "/target/alpha" and gitClone.checkout == "worktree" and gitClone.directory == "/custom/feature"
  )
  assert(
    gitClone.branchMode == "existing" and gitClone.source.sourceHostId == "host" and gitClone.session.kind == "new"
  )
  gitCloneDraft.destination = { branch = "new-feature", label = "new-feature" }
  assert(ui.cloneInputFor(gitCloneDraft).branchMode == "create")
  gitCloneDraft.isCreating = false
  gitClone = ui.cloneInputFor(gitCloneDraft)
  assert(gitClone.checkout == "primary" and gitClone.directory == nil)
  local jjrepo = { vcs = "jj", path = "/projects/alpha", commonDir = "/projects/alpha/.jj/repo", name = "alpha" }
  local revision = { commitId = string.rep("a", 40), changeId = string.rep("k", 32), description = "published base" }
  local choice = { expression = "main@origin", label = "main@origin", revision = revision }
  local jjDraft = {
    machine = host,
    host = host,
    project = jjrepo,
    projectChoice = { name = "alpha", source = { machineKey = "local", hostId = "host", repository = jjrepo } },
    session = { kind = "existing", id = "session" },
    mode = "split",
  }
  local tree = {
    vcs = "jj",
    path = "/projects/alpha.worktrees/source",
    name = "source",
    head = revision.commitId,
    changeId = revision.changeId,
    present = true,
  }
  local opened = ui.selectWorktree(jjDraft, tree)
  assert(ui.inputFor(opened).path == tree.path and opened.sourcePath == tree.path)
  assert(not pcall(ui.selectWorktree, jjDraft, { vcs = "jj", path = s.json.null, name = "legacy", present = false }))
  opened.isCreating, opened.worktreeName, opened.directory = true, "topic", "/custom/topic"
  opened = ui.selectRevision(opened, choice)
  local jjInput = ui.inputFor(opened)
  assert(jjInput.repo == tree.path and jjInput.revision == revision.commitId and jjInput.worktreeName == "topic")
  local cloneDraft = {
    host = host,
    projectChoice = { name = "alpha" },
    session = { kind = "new", name = "Same label" },
    clone = {
      vcs = "jj",
      url = "https://example.com/alpha.git",
      sourceHostId = "host",
      revisions = { choice },
      repo = "/target/alpha",
    },
    isCreating = true,
    worktreeName = "topic",
    directory = "/custom/topic",
  }
  cloneDraft = ui.selectRevision(cloneDraft, choice)
  local clone = ui.cloneInputFor(cloneDraft)
  assert(
    clone.vcs == "jj"
      and clone.revision == revision.commitId
      and clone.checkout == "worktree"
      and clone.directory == "/custom/topic"
  )
  assert(clone.source.revision.commitId == revision.commitId and #clone.source.revisions == 0)
  assert(clone.session.kind == "new" and clone.session.name == "Same label")
  local large = {
    expression = "trunk()",
    label = string.rep("Commit body ", 4000),
    revision = {
      commitId = string.rep("b", 40),
      changeId = string.rep("m", 32),
      description = string.rep("Commit body ", 4000),
    },
  }
  cloneDraft.clone.revisions = { large, choice }
  cloneDraft.clone.revision = large.revision
  local bounded = ui.cloneInputFor(cloneDraft)
  local request = {
    version = 5,
    hostId = "host",
    kind = "clone-launch",
    input = bounded,
    reviewed = {
      vcs = "jj",
      hostId = "host",
      repo = bounded.repo,
      existing = false,
      label = "Clone & Open",
      input = bounded,
    },
  }
  assert(#s.json.encode({ request = s.json.encode(request) }) < 65536)
  local switched = ui.changeProjectChoice(draft, { name = "beta" })
  assert(switched.project == nil and switched.destination == nil and switched.session.id == "session")
end
