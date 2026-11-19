return function(root)
  local runtime = require("runtime")
  local base = root .. "/popup-clone"
  local function run(args)
    local result = runtime.capture(args, { timeout = 120 })
    assert(result.ok, result.stderr .. result.stdout)
  end
  for _, kind in ipairs({ "git", "detached" }) do
    local repo = base .. "/" .. kind .. "/alpha"
    runtime.fs.makeDirectory(repo, { recursive = true })
    run({ "git", "-C", repo, "init", "-b", "main" })
    run({ "git", "-C", repo, "config", "user.name", "Rex Tests" })
    run({ "git", "-C", repo, "config", "user.email", "rex@example.test" })
    runtime.fs.writeFileString(repo .. "/tracked", "base\n")
    run({ "git", "-C", repo, "add", "tracked" })
    run({ "git", "-C", repo, "commit", "-m", "base" })
    run({ "git", "-C", repo, "remote", "add", "origin", "https://example.test/alpha.git" })
    if kind == "detached" then run({ "git", "-C", repo, "checkout", "--detach" }) end
  end
  local jj = base .. "/jj/alpha"
  runtime.fs.makeDirectory(jj, { recursive = true })
  run({ "jj", "git", "init", "--no-colocate", jj })
  run({ "python3", "test/popup-clone.py", base, runtime.path.resolve("dist/rex-worktrees") })
end
