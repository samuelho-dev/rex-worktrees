return function(root)
  local s = require("runtime")
  local bin = root .. "/path-bin"
  s.fs.makeDirectory(bin)
  s.fs.writeFileString(bin .. "/only-here", '#!/bin/sh\nprintf "resolved:%s" "$1"\n')
  s.fs.chmod(bin .. "/only-here", 493)
  local env = s.environment()
  env.PATH = bin
  local resolved = s.capture({ "only-here", "argument" }, { env = env, timeout = 5 })
  assert(resolved.ok and resolved.stdout == "resolved:argument", resolved.stderr)
  local start = s.now()
  local result = s.capture(
    { "/bin/sh", "-c", "head -c 131072 /dev/zero; head -c 131072 /dev/zero >&2; cat >/dev/null; printf done" },
    { stdin = string.rep("x", 262144), timeout = 10 }
  )
  assert(result.ok and not result.timed_out, result.stderr)
  assert(#result.stdout == 131076 and result.stdout:sub(-4) == "done" and #result.stderr == 131072)
  assert(s.now() >= start)
end
