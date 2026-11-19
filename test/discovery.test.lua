return function(root)
  local s, repositories = require("runtime"), require("repositories")
  local fs = s.fs
  local group = root .. "/discovery"
  local function makeRepo(path)
    fs.makeDirectory(path, { recursive = true })
    local result = s.capture({ "git", "-C", path, "init", "-b", "main" })
    assert(result.ok, result.stderr)
  end
  local a, b = group .. "/alpha", group .. "/beta"
  local nested, deep, hidden, outside =
    group .. "/group/nested", group .. "/group/extra/too-deep", group .. "/.hidden", root .. "/outside-project"
  for _, path in ipairs({ a, b, nested, deep, hidden, outside }) do
    makeRepo(path)
  end
  fs.makeDirectory(a .. "/src/deep", { recursive = true })
  local result = s.capture({ "ln", "-s", outside, group .. "/linked-project" })
  assert(result.ok, result.stderr)
  result = s.capture({ "ln", "-s", group .. "/missing", group .. "/broken-link" })
  assert(result.ok, result.stderr)
  local fromContext = repositories.discoverProjects({}, {}, a .. "/src/deep")
  assert(#fromContext == 1 and fromContext[1].path == a)
  assert(#repositories.discoverProjects({}, {}, group) == 0)
  assert(#repositories.discoverProjects({}, {}, group .. "/absent") == 0)
  assert(#repositories.discoverProjects({}, {}) == 0)
  local discovered = repositories.discoverProjects({ group }, {})
  local found = {}
  for _, item in ipairs(discovered) do
    found[item.path] = true
  end
  assert(
    #discovered == 5
      and found[a]
      and found[b]
      and found[nested]
      and found[hidden]
      and found[outside]
      and not found[deep]
  )
  local ordered = repositories.discoverProjects({ group }, { b, outside }, a .. "/src/deep")
  assert(ordered[1].path == a and ordered[2].path == b and ordered[3].path == outside)
end
