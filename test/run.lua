package.path = "src/?.lua;test/?.lua;" .. package.path
local system = require("runtime")
local posix = require("posix.stdlib")
local root = system.path.join(os.getenv("TMPDIR") or "/tmp", "rex-worktrees-test-" .. system.uuid())
system.fs.makeDirectory(root, { recursive = true })
root = system.fs.realPath(root)
for key in pairs(system.environment()) do
  if key:match("^GIT_") or key:match("^REX_") or key:match("^JJ_") then assert(posix.setenv(key, nil)) end
end
for key, value in pairs({
  HOME = root,
  XDG_CONFIG_HOME = root .. "/config",
  XDG_STATE_HOME = root .. "/state",
  JJ_CONFIG = root .. "/jj.toml",
  GIT_CONFIG_NOSYSTEM = "1",
  GIT_CONFIG_GLOBAL = "/dev/null",
  REX_WORKTREES_CONFIG = system.json.encode({ directory = root, config = system.json.object() }),
  NO_COLOR = "1",
}) do
  assert(posix.setenv(key, value, true))
end
local files = system.fs.readDirectory("test")
table.sort(files)
local failures = 0
for _, file in ipairs(files) do
  if file:match("%.test%.lua$") then
    local before = system.environment()
    local fixture = system.path.join(root, file:sub(1, -10))
    system.fs.makeDirectory(fixture, { recursive = true })
    for key, value in pairs({
      HOME = fixture,
      XDG_CONFIG_HOME = fixture .. "/config",
      XDG_STATE_HOME = fixture .. "/state",
      JJ_CONFIG = fixture .. "/jj.toml",
      REX_WORKTREES_CONFIG = system.json.encode({ directory = fixture, config = system.json.object() }),
    }) do
      assert(posix.setenv(key, value, true))
    end
    system.fs.writeFileString(fixture .. "/jj.toml", '[user]\nname = "Rex Tests"\nemail = "rex@example.test"\n')
    local ok, err = xpcall(function() assert(loadfile("test/" .. file))()(fixture) end, debug.traceback)
    for key in pairs(system.environment()) do
      if before[key] == nil then assert(posix.setenv(key, nil)) end
    end
    for key, value in pairs(before) do
      assert(posix.setenv(key, value, true))
    end
    if ok then
      print("ok " .. file)
    else
      failures = failures + 1
      io.stderr:write("FAIL " .. file .. ": " .. tostring(err) .. "\n")
    end
  end
end
system.fs.remove(root, { recursive = true, force = true })
if failures > 0 then os.exit(1) end
