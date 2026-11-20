return function()
  local ui, s = require("chooser"), require("runtime")
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
  local state = s.json.encode({
    draft = { mode = "auto", host = host, machine = host }, origin = s.json.object(), projects = s.json.array(),
    sessions = s.json.array(), cloneRoot = "",
  })
  local editing = ui.request({ op = "edit", state = state, field = "mode" }, {})
  assert(#editing.rows == 7 and editing.editor and #editing.editor.items == 3)
  local invalid = ui.request({ op = "accept", state = editing.state, id = "missing" }, {})
  assert(invalid.error and invalid.editor and invalid.submitDisabled)
  local accepted = ui.request({ op = "accept", state = editing.state, id = editing.editor.items[2].id }, {})
  assert(not accepted.editor and accepted.rows[7].value == "Always new tab")
  local cancelled = ui.request({ op = "cancel", state = editing.state }, {})
  assert(not cancelled.editor and cancelled.rows[7].value == "Reuse matching tab, otherwise new tab")
end
