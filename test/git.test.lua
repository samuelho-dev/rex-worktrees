return function(root)
  local s, git, repos = require("runtime"), require("git"), require("repositories")
  local fs, path = s.fs, s.path
  local dir = path.join(root, "git safety")
  local repo = path.join(dir, "repo with space")
  fs.makeDirectory(repo, { recursive = true })
  local function command(...)
    local args = { "git", "-C", repo, ... }
    local result = s.capture(args)
    assert(result.ok, result.stderr)
    return result.stdout
  end
  command("init", "-b", "main")
  command("config", "user.name", "Rex Tests")
  command("config", "user.email", "rex@example.test")
  fs.writeFileString(path.join(repo, "tracked"), "base\n")
  command("add", "tracked")
  command("commit", "-m", "base")
  local base = command("rev-parse", "HEAD"):match("%S+")
  fs.writeFileString(path.join(repo, "tracked"), "staged\n")
  command("add", "tracked")
  fs.writeFileString(path.join(repo, "tracked"), "dirty\n")
  fs.writeFileString(path.join(repo, "untracked"), "untouched\0bytes")
  local head, branch = command("rev-parse", "HEAD"), command("symbolic-ref", "HEAD")
  local index = fs.readFileString(path.join(repo, ".git", "index"))
  local status = command("status", "--porcelain=v1", "-z")
  local staged = command("diff", "--cached", "--binary")
  local made = git.createWorktree(repo, "feature/B", { startPoint = base })
  assert(made.path == repo .. ".worktrees/feature/B")
  fs.writeFileString(path.join(made.path, "new-file"), "B change\n")
  local b = s.capture({ "git", "-C", made.path, "add", "new-file" })
  assert(b.ok, b.stderr)
  b = s.capture({ "git", "-C", made.path, "commit", "-m", "B commit" })
  assert(b.ok, b.stderr)
  assert(command("rev-parse", "HEAD") == head and command("symbolic-ref", "HEAD") == branch)
  assert(command("status", "--porcelain=v1", "-z") == status and command("diff", "--cached", "--binary") == staged)
  assert(fs.readFileString(path.join(repo, ".git", "index")) == index)
  assert(fs.readFileString(path.join(repo, "tracked")) == "dirty\n")
  assert(fs.readFileString(path.join(repo, "untracked")) == "untouched\0bytes")
  assert(git.repository(made.path).commonDir == git.repository(repo).commonDir)
  assert(repos.project(made.path).path == repo)
  local posix, config = require("posix.stdlib"), require("config")
  local previousConfig = s.getenv("REX_WORKTREES_CONFIG")
  local configEnvelope = {
    directory = dir,
    config = { worktreeRoot = dir .. "/global", projects = { { path = made.path, worktreeRoot = dir .. "/override" } } },
  }
  assert(posix.setenv("REX_WORKTREES_CONFIG", s.json.encode(configEnvelope), true))
  assert(config.resolveWorktreeRoot(made.path) == dir .. "/override")
  assert(config.resolveWorktreeRoot(repo) == dir .. "/override")
  local separate = dir .. "/separate-clone"
  local clone = s.capture({ "git", "clone", repo, separate })
  assert(clone.ok, clone.stderr)
  assert(git.repository(separate).commonDir ~= git.repository(repo).commonDir)
  assert(config.resolveWorktreeRoot(separate) == dir .. "/global/separate-clone")
  assert(posix.setenv("REX_WORKTREES_CONFIG", previousConfig))
  for _, name in ipairs({ "", "../escape", "a/../escape", "/absolute", "a//b", "bad\nname" }) do
    assert(not pcall(git.planWorktree, repo, "feature/invalid", dir .. "/trees", name))
    assert(
      not pcall(git.createWorktree, repo, "feature/invalid", { worktreeRoot = dir .. "/trees", worktreeName = name })
    )
  end
  assert(command("branch", "--list", "feature/invalid") == "")
  fs.makeDirectory(dir .. "/trees", { recursive = true })
  fs.writeFileString(dir .. "/trees/occupied", "keep")
  assert(not pcall(git.createWorktree, repo, "occupied", { worktreeRoot = dir .. "/trees" }))
  assert(fs.readFileString(dir .. "/trees/occupied") == "keep")
  command("branch", "appeared")
  assert(not pcall(git.createWorktree, repo, "appeared", { startPoint = base }))
  assert(not pcall(git.createWorktree, repo, "missing", { attachOnly = true }))
  assert(command("branch", "--list", "missing") == "")
  command("branch", "vanished", base)
  command("update-ref", "refs/remotes/origin/vanished", base)
  local binary = s.capture({ "which", "git" })
  assert(binary.ok, binary.stderr)
  local gitBinary = binary.stdout:match("[^\n]+")
  local bin = dir .. "/race-bin"
  fs.makeDirectory(bin)
  fs.writeFileString(
    bin .. "/git",
    '#!/bin/sh\nif [ "$3 $4" = "worktree add" ]; then '
      .. s.json.encode(gitBinary)
      .. ' -C "$2" branch -D vanished >&2 || exit 1; fi\nexec '
      .. s.json.encode(gitBinary)
      .. ' "$@"\n'
  )
  fs.chmod(bin .. "/git", 493)
  local previousPath = s.getenv("PATH")
  assert(posix.setenv("PATH", bin .. ":" .. previousPath, true))
  local ok = pcall(git.createWorktree, repo, "vanished", { attachOnly = true })
  assert(posix.setenv("PATH", previousPath, true))
  assert(not ok)
  assert(command("branch", "--list", "vanished") == "")
  assert(not fs.exists(repo .. ".worktrees/vanished"))
  local outside = dir .. "/outside"
  fs.makeDirectory(outside)
  local linked = s.capture({ "ln", "-s", outside, dir .. "/trees/link" })
  assert(linked.ok, linked.stderr)
  assert(not pcall(git.createWorktree, repo, "escape", { worktreeRoot = dir .. "/trees/link/sub" }))
  assert(not fs.exists(outside .. "/sub") and command("branch", "--list", "escape") == "")
  assert(not pcall(git.createWorktree, repo, "inside", { worktreeRoot = repo .. "/nested" }))
  assert(command("branch", "--list", "inside") == "")
  local found = repos.discoverProjects({ dir }, { repo, made.path }, made.path)
  assert(#found == 2 and found[1].path == repo and found[2].path == separate)
  command("commit", "-m", "advance")
  local advanced = command("rev-parse", "HEAD"):match("%S+")
  assert(advanced ~= base)
  local pinned = git.createWorktree(repo, "reviewed", { startPoint = base })
  assert(pinned.head == base and command("rev-parse", "HEAD"):match("%S+") == advanced)
  assert(fs.readFileString(pinned.path .. "/tracked") == "base\n")
  for _, url in ipairs({
    "https://user:password@example.org/repo",
    "https://example.org/repo?token=secret",
    "ext::sh -c secret",
    "/source/local.git",
  }) do
    assert(not pcall(git.safeOrigin, url, false))
  end
  assert(git.safeOrigin("git@example.org:org/repo.git", false) == "git@example.org:org/repo.git")
  assert(
    git.safeOrigin("ssh://deploy@[2001:db8::1]/team/repo.git", false) == "ssh://deploy@[2001:db8::1]/team/repo.git"
  )
  assert(git.safeOrigin("https://example.org/team/repo.git", false) == "https://example.org/team/repo.git")
end
