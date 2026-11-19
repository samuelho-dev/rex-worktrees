return function(root)
  local s = require("runtime")
  local repo = root .. "/pty-source"
  s.fs.makeDirectory(repo, { recursive = true })
  local function run(argv)
    local result = s.capture(argv, { timeout = 240 })
    assert(result.ok, result.stderr .. result.stdout)
    return result.stdout
  end
  run({ "git", "-C", repo, "init", "-b", "main" })
  run({ "git", "-C", repo, "config", "user.name", "Rex Tests" })
  run({ "git", "-C", repo, "config", "user.email", "rex@example.test" })
  s.fs.writeFileString(repo .. "/tracked", "base\n")
  run({ "git", "-C", repo, "add", "tracked" })
  run({ "git", "-C", repo, "commit", "-m", "base" })
  local git = run({ "which", "git" }):match("[^\n]+")
  local jj = run({ "which", "jj" }):match("[^\n]+")
  run({
    "python3",
    "test/terminal-driver.py",
    root,
    s.path.resolve("dist/rex-worktrees"),
    s.executable(),
    repo,
    git,
    jj,
  })
end
