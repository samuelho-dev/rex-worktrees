return function(root)
  local s, git, worktrees = require("runtime"), require("git"), require("worktrees")
  local fs = s.fs
  local dir, source = root .. "/clone-case", root .. "/clone-case/source"
  fs.makeDirectory(source, { recursive = true })
  local function cmd(...)
    local result = s.capture({ "git", ... })
    assert(result.ok, result.stderr)
    return result.stdout
  end
  local function at(...) return cmd("-C", source, ...) end
  at("init", "-b", "main")
  at("config", "user.name", "Rex Tests")
  at("config", "user.email", "rex@example.test")
  fs.writeFileString(source .. "/tracked", "base\n")
  at("add", "tracked")
  at("commit", "-m", "base")
  local bare = dir .. "/origin.git"
  cmd("init", "--bare", bare)
  at("remote", "add", "origin", bare)
  at("push", "-u", "origin", "main")
  cmd("--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main")
  at("branch", "published")
  at("push", "origin", "published")
  at("branch", "unpublished")
  fs.writeFileString(source .. "/tracked", "staged\n")
  at("add", "tracked")
  fs.writeFileString(source .. "/tracked", "dirty\n")
  for _, url in ipairs({
    "https://github.com/Owner/Repo.git/", "git@github.com:Owner/Repo.git", "ssh://git@github.com/Owner/Repo",
  }) do
    local parsed = assert(git.githubRepository(url))
    assert(parsed.name == "Repo" and parsed.identity == "owner/repo" and parsed.url == url:gsub("/$", ""))
  end
  for _, url in ipairs({
    "https://user@github.com/a/b", "https://github.com/a/b/tree/main", "https://github.com/a/b?x=1",
    "https://github.com/a/b#fragment", "https://github.com/../b", "https://github.com/a/.git",
    "ssh://other@github.com/a/b", "git@github.com:a/b/", "https://github.com/a/b//",
  }) do
    assert(not git.githubRepository(url), url)
  end
  cmd("--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/published")
  local defaultRepo = dir .. "/remote-default"
  local defaultPlan = {
    vcs = "git", hostId = "fixture-host", repo = defaultRepo, existing = false, label = "Clone & Open",
    input = {
      vcs = "git", source = { vcs = "git", url = bare, sourceHostId = "fixture-host" },
      repo = defaultRepo, session = { kind = "existing", id = "session" }, name = "Task",
      checkout = "primary", branchMode = "default",
    },
  }
  assert(worktrees.prepareCloneCheckout(defaultPlan).cwd == defaultRepo)
  assert(cmd("-C", defaultRepo, "branch", "--show-current"):match("%S+") == "published")
  cmd("-C", defaultRepo, "checkout", "--detach")
  local detachedHead = cmd("-C", defaultRepo, "rev-parse", "HEAD")
  defaultPlan.existing, defaultPlan.commonDir = true, git.repository(defaultRepo).commonDir
  assert(worktrees.prepareCloneCheckout(defaultPlan).cwd == defaultRepo)
  assert(not cmd("-C", defaultRepo, "branch", "--show-current"):match("%S"))
  assert(cmd("-C", defaultRepo, "rev-parse", "HEAD") == detachedHead)
  for _, invalid in ipairs({
    { branch = "main" }, { worktreeName = "task" }, { directory = dir .. "/tree" }, { checkout = "worktree" },
  }) do
    local input = {}
    for key, value in pairs(defaultPlan.input) do input[key] = value end
    for key, value in pairs(invalid) do input[key] = value end
    local invalidPlan = {}
    for key, value in pairs(defaultPlan) do invalidPlan[key] = value end
    invalidPlan.input = input
    assert(not pcall(worktrees.prepareCloneCheckout, invalidPlan))
  end
  local externalPlan = {}
  for key, value in pairs(defaultPlan) do externalPlan[key] = value end
  externalPlan.input = {}
  for key, value in pairs(defaultPlan.input) do externalPlan.input[key] = value end
  for _, url in ipairs({ bare, "file://" .. bare }) do
    externalPlan.input.source = { vcs = "git", url = url }
    assert(not pcall(worktrees.prepareCloneCheckout, externalPlan))
  end
  cmd("-C", defaultRepo, "remote", "set-url", "origin", "git@github.com:Owner/Repo.git")
  assert(worktrees.cloneDestination(defaultRepo, "https://github.com/owner/repo", "git") == defaultPlan.commonDir)
  assert(not pcall(worktrees.cloneDestination, defaultRepo, "https://github.com/owner/other", "git"))
  defaultPlan.input.source = { vcs = "git", url = "ssh://git@github.com/OWNER/REPO" }
  assert(worktrees.prepareCloneCheckout(defaultPlan).cwd == defaultRepo)
  assert(cmd("-C", defaultRepo, "remote", "get-url", "origin") == "git@github.com:Owner/Repo.git\n")
  cmd("--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main")
  local before, head = at("status", "--porcelain=v1", "-z"), at("rev-parse", "HEAD")
  local described = git.cloneSource(source, "fixture-host")
  assert(described.url == bare)
  local dest = dir .. "/clone"
  git.cloneRepository(bare, dest)
  assert(git.repository(dest).path == dest)
  local branches = git.remoteBranches(dest)
  local seen = {}
  for _, branch in ipairs(branches) do
    seen[branch] = true
  end
  assert(seen.published and not seen.unpublished)
  local plan = {
    vcs = "git",
    hostId = "fixture-host",
    repo = dir .. "/prepared",
    existing = false,
    label = "Clone & Open",
    input = {
      vcs = "git",
      source = {
        vcs = "git",
        url = bare,
        sourceHostId = "fixture-host",
        branches = { "main", "published", "unpublished" },
      },
      repo = dir .. "/prepared",
      session = { kind = "existing", id = "session" },
      name = "Task",
      branch = "published",
      branchMode = "existing",
    },
  }
  local function clonePlanAt(repo, branch)
    local input = {}
    for key, value in pairs(plan.input) do
      input[key] = value
    end
    input.repo, input.branch = repo, branch
    return { vcs = plan.vcs, hostId = plan.hostId, repo = repo, existing = false, label = plan.label, input = input }
  end
  local prepared = worktrees.prepareCloneCheckout(plan)
  assert(prepared.cwd == plan.repo .. ".worktrees/published")
  assert(cmd("-C", prepared.cwd, "branch", "--show-current"):match("%S+") == "published")
  assert(at("status", "--porcelain=v1", "-z") == before and at("rev-parse", "HEAD") == head)
  assert(fs.readFileString(source .. "/tracked") == "dirty\n")
  local missing = dir .. "/missing"
  assert(not pcall(worktrees.prepareCloneCheckout, clonePlanAt(missing, "unpublished")))
  assert(git.repository(missing).path == missing)
  local collision = dir .. "/collision"
  fs.makeDirectory(collision)
  fs.writeFileString(collision .. "/keep", "unchanged")
  assert(not pcall(worktrees.prepareCloneCheckout, clonePlanAt(collision, "published")))
  assert(fs.readFileString(collision .. "/keep") == "unchanged")
  local link = dir .. "/symlink"
  local linked = s.capture({ "ln", "-s", collision, link })
  assert(linked.ok, linked.stderr)
  assert(not pcall(worktrees.prepareCloneCheckout, clonePlanAt(link .. "/nested", "published")))
  assert(fs.readFileString(collision .. "/keep") == "unchanged" and not fs.exists(collision .. "/nested"))
  local existing = git.repository(dest)
  local defaultBase = cmd("-C", dest, "rev-parse", "refs/remotes/origin/HEAD"):match("%S+")
  local existingPlan = {
    vcs = "git",
    hostId = "fixture-host",
    repo = dest,
    existing = true,
    commonDir = existing.commonDir,
    base = defaultBase,
    label = "Open existing repository",
    input = {
      vcs = "git",
      source = { vcs = "git", url = bare, sourceHostId = "fixture-host", branches = { "main" } },
      repo = dest,
      session = { kind = "existing", id = "session" },
      name = "Task",
      branch = "new-from-default",
      branchMode = "create",
    },
  }
  local selected = worktrees.prepareCloneCheckout(existingPlan)
  assert(cmd("-C", selected.cwd, "rev-parse", "HEAD"):match("%S+") == defaultBase)
  fs.rename(dest, dir .. "/displaced")
  cmd("clone", "--separate-git-dir=" .. dir .. "/replacement-metadata", bare, dest)
  local replacementInput = {}
  for key, value in pairs(existingPlan.input) do
    replacementInput[key] = value
  end
  replacementInput.branch = "replacement-test"
  local replacementPlan = {}
  for key, value in pairs(existingPlan) do
    replacementPlan[key] = value
  end
  replacementPlan.input = replacementInput
  assert(not pcall(worktrees.prepareCloneCheckout, replacementPlan))
  assert(cmd("-C", dest, "branch", "--list", "replacement-test") == "")
  local metadata = dir .. "/replacement-metadata"
  local metaHead = fs.readFileString(metadata .. "/HEAD")
  assert(not pcall(worktrees.cloneDestination, metadata .. "/nested", bare))
  assert(fs.readFileString(metadata .. "/HEAD") == metaHead and not fs.exists(metadata .. "/nested"))
  local jj = require("jj")
  local jjSource = dir .. "/jj-source"
  jj.cloneRepository(bare, jjSource)
  local revision = jj.resolveRevision(jjSource, "@-")
  local jjDestination, jjWorkspace = dir .. "/jj-target", dir .. "/custom/fresh"
  local jjPlan = {
    vcs = "jj",
    hostId = "fixture-host",
    repo = jjDestination,
    existing = false,
    label = "Clone & Open",
    base = revision,
    input = {
      vcs = "jj",
      source = {
        vcs = "jj",
        url = bare,
        sourceHostId = "fixture-host",
        revisions = { { expression = revision.commitId, label = "base", revision = revision } },
        revision = revision,
      },
      repo = jjDestination,
      session = { kind = "existing", id = "session" },
      name = "Task",
      checkout = "worktree",
      directory = jjWorkspace,
      worktreeName = "fresh",
      revision = revision.commitId,
    },
  }
  local jjPrepared = worktrees.prepareCloneCheckout(jjPlan)
  assert(jjPrepared.repo.vcs == "jj" and jjPrepared.cwd == jjWorkspace)
  assert(jj.resolveRevision(jjWorkspace, "@-").commitId == revision.commitId)
  local found = false
  for _, workspace in ipairs(jj.listWorkspaces(jjDestination)) do
    if workspace.name == "fresh" then found = true end
  end
  assert(found and not pcall(worktrees.prepareCloneCheckout, jjPlan))
  local primaryRepo = dir .. "/jj-primary"
  local primaryPlan = {
    vcs = "jj",
    hostId = "fixture-host",
    repo = primaryRepo,
    existing = false,
    label = "Clone & Open",
    base = revision,
    input = {
      vcs = "jj",
      source = jjPlan.input.source,
      repo = primaryRepo,
      session = jjPlan.input.session,
      name = "Task",
      checkout = "primary",
      revision = revision.commitId,
    },
  }
  local primary = worktrees.prepareCloneCheckout(primaryPlan)
  assert(primary.cwd == primaryRepo and jj.resolveRevision(primaryRepo, "@-").commitId == revision.commitId)
  local workspaces = jj.listWorkspaces(primaryRepo)
  assert(#workspaces == 1 and workspaces[1].name == "default")
  assert(jj.cloneSource(jjSource, "fixture-host").url == bare)
  fs.writeFileString(jjSource .. "/unpublished", "local only")
  local changed = s.capture({ "jj", "-R", jjSource, "describe", "-m", "not pushed" })
  assert(changed.ok, changed.stderr)
  local unpublished = jj.resolveRevision(jjSource, "@")
  local jjSecond = dir .. "/jj-second"
  jj.cloneRepository(bare, jjSecond)
  assert(not fs.exists(jjSecond .. "/unpublished"))
  assert(not pcall(jj.newChange, jjSecond, unpublished))
  assert(jj.repository(jjSecond).vcs == "jj")
  local published = jj.resolveRevision(jjSecond, "@-")
  local change = jj.newChange(jjSecond, published)
  assert(jj.resolveRevision(jjSecond, "@-").commitId == published.commitId and change.changeId ~= published.changeId)
end
