return function(root)
  local runtime = require("runtime")
  local repo = root .. "/popup-remote/alpha"
  runtime.fs.makeDirectory(repo, { recursive = true })
  local function run(args)
    local result = runtime.capture(args, { timeout = 120 })
    assert(result.ok, result.stderr .. result.stdout)
  end
  run({ "git", "-C", repo, "init", "-b", "main" })
  run({ "git", "-C", repo, "config", "user.name", "Rex Tests" })
  run({ "git", "-C", repo, "config", "user.email", "rex@example.test" })
  runtime.fs.writeFileString(repo .. "/tracked", "base\n")
  run({ "git", "-C", repo, "add", "tracked" })
  run({ "git", "-C", repo, "commit", "-m", "base" })
  run({ "git", "-C", repo, "remote", "add", "origin", "https://example.test/alpha.git" })
  run({ "python3", "test/popup-remote.py", root .. "/popup-remote", runtime.path.resolve("dist/rex-worktrees"), repo })
end
