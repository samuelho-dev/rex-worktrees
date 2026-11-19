return function()
  local rex, system = require("rex"), require("runtime")
  local host = system.hostname():gsub("%.$", ""):gsub("%.[lL][oO][cC][aA][lL]$", "")
  assert(rex.localDirectoryUri("file://" .. host .. ".local/tmp/project%20one") == "/tmp/project one")
  assert(rex.localDirectoryUri("file://" .. host .. "/tmp/project") == "/tmp/project")
  assert(rex.localDirectoryUri("file:///tmp/project") == "/tmp/project")
  assert(rex.localDirectoryUri("file://localhost/tmp/project") == "/tmp/project")
  assert(rex.localDirectoryUri("/tmp/project%20one") == "/tmp/project%20one")
  for _, uri in ipairs({
    "file://remote.invalid/tmp/project",
    "file:///tmp/project%00",
    "ssh://localhost/tmp/project",
    "file://localhost/tmp/project?query",
    "relative/project",
    "/tmp/project\0",
  }) do
    assert(rex.localDirectoryUri(uri) == nil)
  end
end
