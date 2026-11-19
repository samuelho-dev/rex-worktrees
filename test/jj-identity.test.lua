return function(root)
  local s, jj, repos = require("runtime"), require("jj"), require("repositories")
  local repo = root .. "/jj-colocated"
  s.fs.makeDirectory(repo, { recursive = true })
  local function git(...)
    local result = s.capture({ "git", "-C", repo, ... })
    assert(result.ok, result.stderr)
    return result.stdout
  end
  git("init", "-b", "main")
  git("config", "user.name", "Rex Tests")
  git("config", "user.email", "rex@example.test")
  s.fs.writeFileString(repo .. "/one", "one")
  git("add", "one")
  git("commit", "-m", "one")
  local reviewed = git("rev-parse", "HEAD"):match("%S+")
  s.fs.writeFileString(repo .. "/two", "two")
  git("add", "two")
  git("commit", "-m", "two")
  local different = git("rev-parse", "HEAD"):match("%S+")
  local init = s.capture({ "jj", "git", "init", repo })
  assert(init.ok, init.stderr)
  local backend = repos.repository(repo)
  assert(backend.vcs == "jj" and backend.commonDir == jj.repository(repo).commonDir)
  s.fs.writeFileString(repo .. "/unsnapshotted", "untouched")
  local original = jj.resolveRevision(repo, "@")
  local index = s.fs.readFileString(repo .. "/.git/index")
  jj.listWorkspaces(repo)
  jj.listRevisions(repo)
  assert(jj.resolveRevision(repo, "@").commitId == original.commitId)
  assert(
    s.fs.readFileString(repo .. "/unsnapshotted") == "untouched" and s.fs.readFileString(repo .. "/.git/index") == index
  )
  local plan = jj.planWorkspace(repo, "pinned", reviewed)
  git("tag", reviewed, different)
  local created = jj.createWorkspace(repo, plan.workspaceName, plan.base)
  local parent = jj.resolveRevision(created.path, "@-").commitId
  assert(
    parent == reviewed,
    "workspace parent " .. parent .. " differs from reviewed " .. reviewed .. " (tag points to " .. different .. ")"
  )
  assert(not s.fs.exists(created.path .. "/unsnapshotted"))
  local external = root .. "/external.git"
  local bare = s.capture({ "git", "init", "--bare", external })
  assert(bare.ok, bare.stderr)
  local linked = root .. "/jj-external"
  local imported = s.capture({ "jj", "git", "init", "--git-repo", external, linked })
  assert(imported.ok, imported.stderr)
  local base = jj.resolveRevision(linked, "@-")
  assert(not pcall(jj.planWorkspace, linked, "inside-git", base.commitId, external))
  assert(#jj.listWorkspaces(linked) == 1)
end
