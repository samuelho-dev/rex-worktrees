return function(root)
  local s, git, repos, worktrees = require("runtime"), require("git"), require("repositories"), require("worktrees")
  local fs, posix = s.fs, require("posix.stdlib")
  local dir = root .. "/checkout-safety"
  fs.makeDirectory(dir, { recursive = true })
  local cleanEnv = s.environment()
  for key in pairs(cleanEnv) do
    if key:match("^GIT_") then cleanEnv[key] = nil end
  end
  local function command(...)
    local result = s.capture({ ... }, { env = cleanEnv })
    assert(result.ok, result.stderr)
    return result.stdout
  end
  local function at(repo, ...) return command("git", "-C", repo, ...) end
  local function init(repo)
    fs.makeDirectory(repo, { recursive = true })
    at(repo, "init", "-b", "main")
    at(repo, "config", "user.name", "Rex Tests")
    at(repo, "config", "user.email", "rex@example.test")
    fs.writeFileString(repo .. "/tracked", "base\n")
    at(repo, "add", "tracked")
    at(repo, "commit", "-m", "base")
  end
  local function dirty(repo)
    fs.writeFileString(repo .. "/tracked", "staged\n")
    at(repo, "add", "tracked")
    fs.writeFileString(repo .. "/tracked", "dirty\n")
    fs.writeFileString(repo .. "/untracked", "untouched\0bytes")
  end
  local function snapshot(repo, indexPath)
    return {
      head = at(repo, "rev-parse", "HEAD"),
      branch = at(repo, "symbolic-ref", "HEAD"),
      index = fs.readFileString(indexPath),
      staged = at(repo, "diff", "--cached", "--binary"),
      status = at(repo, "status", "--porcelain=v1", "-z"),
      tracked = fs.readFileString(repo .. "/tracked"),
      untracked = fs.readFileString(repo .. "/untracked"),
    }
  end
  local function unchanged(repo, indexPath, before)
    local after = snapshot(repo, indexPath)
    for key, value in pairs(before) do
      assert(after[key] == value, "source checkout changed: " .. key)
    end
  end

  local source, hostile = dir .. "/source with space\nand newline", dir .. "/hostile"
  init(source)
  init(hostile)
  at(source, "branch", "free")
  dirty(source)
  dirty(hostile)
  local original = snapshot(source, source .. "/.git/index")
  local other = snapshot(hostile, hostile .. "/.git/index")
  local previous = s.getenv("GIT_DIR")
  assert(posix.setenv("GIT_DIR", hostile .. "/.git", true))
  local ok, err = xpcall(function()
    local created = git.createWorktree(source, "free")
    assert(created.branch == "free")
    assert(git.repository(created.path).commonDir == fs.realPath(source .. "/.git"))
    assert(git.planWorktree(source, "free").path == created.path)
    assert(git.createWorktree(source, "free").path == created.path)
    local nested = git.createWorktree(created.path, "nested/new")
    assert(nested.path == source .. ".worktrees/nested/new")
    fs.writeFileString(nested.path .. "/new-file", "independent\n")
    at(nested.path, "add", "new-file")
    at(nested.path, "commit", "-m", "independent")
    local project = repos.project(created.path)
    assert(project.path == source and project.commonDir == fs.realPath(source .. "/.git"))
    unchanged(source, source .. "/.git/index", original)
    unchanged(hostile, hostile .. "/.git/index", other)
  end, debug.traceback)
  assert(posix.setenv("GIT_DIR", previous, true))
  assert(ok, err)

  local external, metadata = dir .. "/separate checkout", dir .. "/separate metadata"
  command("git", "clone", "--separate-git-dir=" .. metadata, source, external)
  command("git", "--git-dir=" .. metadata, "config", "core.worktree", external)
  local linked = dir .. "/linked checkout"
  at(external, "worktree", "add", "-b", "linked", linked)
  fs.makeDirectory(linked .. "/nested")
  local checkout = git.repository(linked .. "/nested")
  local project = repos.project(linked .. "/nested")
  assert(checkout.path == linked and checkout.commonDir == fs.realPath(metadata))
  assert(project.path == external and project.commonDir == checkout.commonDir)
  local found = repos.discoverProjects({}, { linked, external }, linked .. "/nested")
  assert(#found == 1 and found[1].path == external and found[1].commonDir == checkout.commonDir)
  local metadataHead = fs.readFileString(metadata .. "/HEAD")
  assert(
    not pcall(
      git.createWorktree,
      external,
      "metadata/new",
      { worktreeRoot = dir, worktreeName = "separate metadata/new" }
    )
  )
  assert(fs.readFileString(metadata .. "/HEAD") == metadataHead and not fs.exists(metadata .. "/new"))
  assert(at(external, "branch", "--list", "metadata/new") == "")
  assert(not pcall(git.createWorktree, external, "inside-linked", { worktreeRoot = linked .. "/nested" }))
  assert(not fs.exists(linked .. "/nested/inside-linked") and at(external, "branch", "--list", "inside-linked") == "")
  local caseAlias = dir .. "/SEPARATE CHECKOUT"
  local hasAlias, aliasInfo = s.try(function() return fs.stat(caseAlias) end)
  local actualInfo = fs.stat(external)
  if hasAlias and aliasInfo.dev == actualInfo.dev and aliasInfo.ino == actualInfo.ino then
    assert(not pcall(git.createWorktree, external, "inode-alias", { worktreeRoot = caseAlias .. "/new" }))
    assert(not fs.exists(external .. "/new") and at(external, "branch", "--list", "inode-alias") == "")
  end
  local alias = dir .. "/checkout-alias"
  command("ln", "-s", linked, alias)
  assert(not pcall(git.createWorktree, external, "symlink-alias", { worktreeRoot = alias .. "/nested" }))
  assert(not fs.exists(linked .. "/nested/symlink-alias") and at(external, "branch", "--list", "symlink-alias") == "")

  local occupied = dir .. "/occupied root"
  fs.makeDirectory(occupied .. "/reserved", { recursive = true })
  fs.writeFileString(occupied .. "/reserved/keep", "keep")
  assert(
    not pcall(
      git.createWorktree,
      external,
      "directory-conflict",
      { worktreeRoot = occupied, worktreeName = "reserved" }
    )
  )
  assert(fs.readFileString(occupied .. "/reserved/keep") == "keep")
  assert(at(external, "branch", "--list", "directory-conflict") == "")
  local reviewed = at(external, "rev-parse", "HEAD"):match("%S+")
  assert(
    not pcall(
      git.createWorktree,
      external,
      "linked",
      { startPoint = reviewed, worktreeRoot = occupied, worktreeName = "other" }
    )
  )
  assert(not fs.exists(occupied .. "/other") and at(linked, "rev-parse", "HEAD"):match("%S+") == reviewed)

  local bare = dir .. "/primary project.git"
  command("git", "init", "--bare", bare)
  at(source, "push", bare, "main")
  at(bare, "symbolic-ref", "HEAD", "refs/heads/main")
  local bareLinked = dir .. "/bare linked"
  at(bare, "worktree", "add", "-b", "bare-feature", bareLinked, "main")
  local bareCheckout = git.repository(bareLinked)
  local bareProject = repos.project(bareLinked)
  assert(bareProject.path == bareLinked and bareProject.name == "primary project.git")
  assert(bareProject.commonDir == bareCheckout.commonDir and bareCheckout.commonDir == fs.realPath(bare))
  local bareFound = repos.discoverProjects({}, {}, bareLinked)
  assert(#bareFound == 1 and bareFound[1].path == bareLinked and bareFound[1].name == "primary project.git")

  local clone = dir .. "/origin checkout"
  command("git", "clone", bare, clone)
  at(clone, "config", "user.name", "Rex Tests")
  at(clone, "config", "user.email", "rex@example.test")
  local base = at(clone, "rev-parse", "refs/remotes/origin/HEAD"):match("%S+")
  at(clone, "switch", "-c", "local-feature")
  fs.writeFileString(clone .. "/tracked", "advanced\n")
  at(clone, "add", "tracked")
  at(clone, "commit", "-m", "advance")
  dirty(clone)
  local cloneBefore = snapshot(clone, clone .. "/.git/index")
  local plan = {
    vcs = "git",
    hostId = "fixture-host",
    repo = clone,
    existing = true,
    commonDir = git.repository(clone).commonDir,
    base = base,
    label = "Open existing repository",
    input = {
      vcs = "git",
      source = { vcs = "git", url = bare, sourceHostId = "fixture-host", branches = { "main" } },
      repo = clone,
      session = { kind = "existing", id = "session" },
      name = "Task",
      branch = "reviewed-base",
      branchMode = "create",
    },
  }
  local prepared = worktrees.prepareCloneCheckout(plan)
  assert(at(prepared.cwd, "rev-parse", "HEAD"):match("%S+") == base)
  assert(fs.readFileString(prepared.cwd .. "/tracked") == "base\n")
  unchanged(clone, clone .. "/.git/index", cloneBefore)
  at(clone, "update-ref", "refs/remotes/origin/main", cloneBefore.head:match("%S+"))
  plan.input.branch = "moved-origin-base"
  assert(not pcall(worktrees.prepareCloneCheckout, plan))
  assert(at(clone, "branch", "--list", "moved-origin-base") == "")
  assert(not fs.exists(clone .. ".worktrees/moved-origin-base"))
  unchanged(clone, clone .. "/.git/index", cloneBefore)
  at(clone, "update-ref", "refs/remotes/origin/main", base)
  local otherBare = dir .. "/other-origin.git"
  command("git", "init", "--bare", otherBare)
  at(clone, "remote", "set-url", "origin", otherBare)
  plan.input.branch = "wrong-origin"
  assert(not pcall(worktrees.prepareCloneCheckout, plan))
  assert(at(clone, "branch", "--list", "wrong-origin") == "")
  assert(not fs.exists(clone .. ".worktrees/wrong-origin"))
  unchanged(clone, clone .. "/.git/index", cloneBefore)
end
