return function(root)
  local runtime = require("runtime")
  local repo = root .. "/popup-form/alpha"
  runtime.fs.makeDirectory(repo, { recursive = true })
  local function run(args)
    local result = runtime.capture(args, { timeout = 180 })
    assert(result.ok, result.stderr .. result.stdout)
  end
  run({ "git", "-C", repo, "init", "-b", "main" })
  run({ "git", "-C", repo, "config", "user.name", "Rex Tests" })
  run({ "git", "-C", repo, "config", "user.email", "rex@example.test" })
  runtime.fs.writeFileString(repo .. "/tracked", "base\n")
  run({ "git", "-C", repo, "add", "tracked" })
  run({ "git", "-C", repo, "commit", "-m", "base" })
  run({ "python3", "test/popup-form.py", root .. "/popup-form", runtime.path.resolve("dist/rex-worktrees"), repo })
end
