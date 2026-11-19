return function(root)
  local s, jj = require("runtime"), require("jj")
  local repo = root .. "/jj-conflict"
  local result = s.capture({ "jj", "git", "init", "--no-colocate", repo })
  assert(result.ok, result.stderr)
  local function command(...)
    local child = s.capture({ "jj", "-R", repo, ... })
    assert(child.ok, child.stderr)
    return child.stdout
  end
  s.fs.writeFileString(repo .. "/shared", "base")
  command("describe", "-m", "base")
  command("bookmark", "create", "production", "-r", "@")
  local base = jj.resolveRevision(repo, "production").commitId
  command("new", "production")
  s.fs.writeFileString(repo .. "/shared", "first")
  command("describe", "-m", "first")
  local first = jj.resolveRevision(repo, "@").commitId
  command("new", "production")
  s.fs.writeFileString(repo .. "/shared", "second")
  command("describe", "-m", "second")
  local second = jj.resolveRevision(repo, "@").commitId
  command("new", first, second)
  s.fs.writeFileString(
    root .. "/jj.toml",
    '[user]\nname = "Rex Tests"\nemail = "rex@example.test"\n[revset-aliases]\n"trunk()" = "@"\n'
  )
  local choices = jj.listRevisions(repo)
  local hasBase = false
  for _, choice in ipairs(choices) do
    assert(choice.expression ~= "trunk()")
    if choice.revision.commitId == base then hasBase = true end
  end
  assert(hasBase)
  assert(not pcall(jj.resolveRevision, repo, "@"))
  s.fs.writeFileString(
    root .. "/jj.toml",
    '[user]\nname = "Rex Tests"\nemail = "rex@example.test"\n[revset-aliases]\n"trunk()" = "production"\n'
  )
  s.fs.writeFileString(repo .. "/shared", "resolved")
  command("describe", "-m", "resolved merge")
  local merge = jj.resolveRevision(repo, "@")
  local planned = jj.planWorkspace(repo, "from-merge", merge.commitId)
  local workspace = jj.createWorkspace(repo, planned.workspaceName, planned.base)
  assert(jj.resolveRevision(workspace.path, "@-").commitId == merge.commitId)
  assert(s.fs.readFileString(workspace.path .. "/shared") == "resolved")
end
