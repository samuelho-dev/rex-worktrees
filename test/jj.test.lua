return function(root)
  local s, jj, repos = require("runtime"), require("jj"), require("repositories")
  local repo = root .. "/jj-source"
  local function command(...)
    local result = s.capture({ "jj", "-R", repo, ... })
    assert(result.ok, result.stderr)
    return result.stdout
  end
  local initialized = s.capture({ "jj", "git", "init", "--no-colocate", repo })
  assert(initialized.ok, initialized.stderr)
  s.fs.writeFileString(repo .. "/base", "published content")
  command("describe", "-m", "base")
  local base = jj.resolveRevision(repo, "@")
  s.fs.writeFileString(repo .. "/pending", "source only")
  local before = jj.resolveRevision(repo, "@")
  local plan = jj.planWorkspace(repo, "feature", base.commitId)
  assert(plan.path == repo .. ".worktrees/feature")
  assert(plan.base.commitId == base.commitId)
  assert(jj.resolveRevision(repo, "@").commitId == before.commitId)
  local made = jj.createWorkspace(repo, plan.workspaceName, plan.base)
  assert(made.present and made.name == "feature" and made.changeId ~= base.changeId)
  assert(jj.resolveRevision(made.path, "@-").commitId == base.commitId)
  assert(s.fs.readFileString(made.path .. "/base") == "published content")
  assert(not s.fs.exists(made.path .. "/pending"))
  assert(s.fs.readFileString(repo .. "/pending") == "source only")
  assert(jj.repository(repo).commonDir == jj.repository(made.path).commonDir)
  assert(repos.repository(repo).vcs == "jj")
  assert(jj.project(made.path).path == repo)
  command("bookmark", "create", "production", "-r", base.commitId)
  command("new", "production")
  s.fs.writeFileString(
    root .. "/jj.toml",
    '[user]\nname = "Rex Tests"\nemail = "rex@example.test"\n[revset-aliases]\n"trunk()" = "production"\n'
  )
  local revisions = jj.listRevisions(repo)
  assert(revisions[1].expression == "trunk()" and revisions[1].revision.commitId == base.commitId)
  local duplicate = 0
  for _, choice in ipairs(revisions) do
    if choice.revision.commitId == base.commitId then duplicate = duplicate + 1 end
  end
  assert(duplicate == 1)
  for _, alias in ipairs({ "root()", "missing-bookmark", "all()" }) do
    s.fs.writeFileString(
      root .. "/jj.toml",
      '[user]\nname = "Rex Tests"\nemail = "rex@example.test"\n[revset-aliases]\n"trunk()" = "' .. alias .. '"\n'
    )
    local alternatives = jj.listRevisions(repo)
    local foundBase = false
    for _, item in ipairs(alternatives) do
      assert(item.expression ~= "trunk()")
      if item.revision.commitId == base.commitId then foundBase = true end
    end
    assert(foundBase)
  end
  for _, name in ipairs({ "../escape", "-option", "a/b", "  ", "bad\nname" }) do
    assert(not pcall(jj.planWorkspace, repo, name, base.commitId))
  end
  assert(not pcall(jj.resolveRevision, repo, "all()"))
  assert(not pcall(jj.resolveRevision, repo, "no-such-revision"))
  assert(not pcall(jj.planWorkspace, repo, "feature", base.commitId))
  s.fs.rename(made.path, root .. "/moved-workspace")
  local found
  for _, item in ipairs(jj.listWorkspaces(repo)) do
    if item.name == "feature" then found = item end
  end
  assert(found and not found.present and found.path == made.path)
  local posix = require("posix.stdlib")
  local previousPath = s.getenv("PATH")
  local emptyPath = root .. "/no-jj-bin"
  s.fs.makeDirectory(emptyPath)
  assert(posix.setenv("PATH", emptyPath, true))
  local ok, failure = pcall(repos.repository, repo)
  assert(posix.setenv("PATH", previousPath, true))
  assert(not ok and s.message(failure):find("jj executable not found", 1, true))
  assert(s.fs.exists(repo .. "/.jj"))
end
