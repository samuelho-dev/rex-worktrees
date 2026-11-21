local unistd = require("posix.unistd")
local fcntl = require("posix.fcntl")
local stat = require("posix.sys.stat")
local wait = require("posix.sys.wait")
local signal = require("posix.signal")
local poll = require("posix.poll")
local dirent = require("posix.dirent")
local stdlib = require("posix.stdlib")
local errno = require("posix.errno")
local uts = require("posix.sys.utsname")
local json = require("json")
local system = require("system")
local utf = require("lua-utf8")
local M = {}
local errorMeta = { __tostring = function(e) return e.message end }
function M.fail(message, fields)
  fields = fields or {}
  fields.message = message
  error(setmetatable(fields, errorMeta), 0)
end
function M.message(err) return type(err) == "table" and tostring(err.message or err) or tostring(err) end
function M.missing(err) return type(err) == "table" and err.code == "ENOENT" end
M.try = pcall
local function checked(value, message, code)
  if value == nil or value == false then
    local name
    for k, v in pairs(errno) do
      if type(k) == "string" and k:match("^E[A-Z]+$") and v == code then
        name = k
        break
      end
    end
    M.fail(message or "System call failed", { code = name })
  end
  return value
end
M.json = json
function M.isNull(value) return value == json.null end
local path = { sep = "/" }
function path.isAbsolute(p) return type(p) == "string" and p:sub(1, 1) == "/" end
function M.cwd() return checked(unistd.getcwd()) end
function path.resolve(...)
  local values = { ... }
  local parts = {}
  local absolute = false
  for i = #values, 1, -1 do
    local p = values[i]
    if type(p) ~= "string" then M.fail("Path must be a string") end
    table.insert(parts, 1, p)
    if path.isAbsolute(p) then
      absolute = true
      break
    end
  end
  if not absolute then table.insert(parts, 1, M.cwd()) end
  local stack = {}
  for part in table.concat(parts, "/"):gmatch("[^/]+") do
    if part == ".." then
      if #stack > 0 then stack[#stack] = nil end
    elseif part ~= "." and part ~= "" then
      stack[#stack + 1] = part
    end
  end
  return "/" .. table.concat(stack, "/")
end
function path.join(...)
  local parts = { ... }
  local s = table.concat(parts, "/")
  local abs = path.isAbsolute(s)
  local out = {}
  for p in s:gmatch("[^/]+") do
    if p == ".." and #out > 0 and out[#out] ~= ".." then
      out[#out] = nil
    elseif p == ".." and not abs then
      out[#out + 1] = p
    elseif p ~= "." and p ~= ".." then
      out[#out + 1] = p
    end
  end
  local result = (abs and "/" or "") .. table.concat(out, "/")
  return result ~= "" and result or (abs and "/" or ".")
end
function path.dirname(p)
  p = p:gsub("/+$", "")
  local d = p:match("^(.*)/[^/]*$")
  return d and (d == "" and "/" or d) or (p == "" and "/" or ".")
end
function path.basename(p)
  p = p:gsub("/+$", "")
  return p:match("[^/]+$") or ""
end
function path.parse(p) return { root = path.isAbsolute(p) and "/" or "" } end
M.path = path
local fs = {}
local function info(fn, p)
  local s = checked(fn(p))
  local mode = s.st_mode
  local kind = stat.S_ISREG(mode) ~= 0 and "File"
    or stat.S_ISDIR(mode) ~= 0 and "Directory"
    or stat.S_ISLNK(mode) ~= 0 and "SymbolicLink"
    or "Other"
  return { type = kind, mode = mode & 4095, ino = s.st_ino, dev = s.st_dev, size = s.st_size }
end
function fs.stat(p) return info(stat.stat, p) end
function fs.lstat(p) return info(stat.lstat, p) end
function fs.exists(p)
  local ok, v = pcall(fs.lstat, p)
  if ok then return true end
  if M.missing(v) then return false end
  error(v, 0)
end
function fs.realPath(p) return checked(stdlib.realpath(p)) end
function fs.access(p, mode) return checked(unistd.access(p, mode)) end
function fs.readFileString(p)
  local fd = checked(fcntl.open(p, fcntl.O_RDONLY))
  local chunks = {}
  while true do
    local data, err, code = unistd.read(fd, 65536)
    if not data then
      unistd.close(fd)
      checked(data, err, code)
    end
    if #data == 0 then break end
    chunks[#chunks + 1] = data
  end
  checked(unistd.close(fd))
  return table.concat(chunks)
end
local function writeAll(fd, data)
  local offset = 1
  while offset <= #data do
    local count, err, code = unistd.write(fd, data:sub(offset))
    if not count then checked(count, err, code) end
    offset = offset + count
  end
end
function fs.writeFileString(p, content, opts)
  opts = opts or {}
  local flags = fcntl.O_WRONLY | fcntl.O_CREAT
  if opts.flag == "wx" then
    flags = flags | fcntl.O_EXCL
  elseif opts.flag == "a" then
    flags = flags | fcntl.O_APPEND
  else
    flags = flags | fcntl.O_TRUNC
  end
  local fd = checked(fcntl.open(p, flags, opts.mode or 438))
  local ok, err = pcall(writeAll, fd, content)
  local closed, ce, cc = unistd.close(fd)
  if not ok then error(err, 0) end
  checked(closed, ce, cc)
end
function fs.readDirectory(p)
  checked(unistd.access(p, "r"))
  local result = json.array()
  for v in dirent.files(p) do
    if v ~= "." and v ~= ".." then result[#result + 1] = v end
  end
  return result
end
function fs.makeDirectory(p, opts)
  opts = opts or {}
  if opts.recursive then
    local current = path.isAbsolute(p) and "/" or "."
    for part in p:gmatch("[^/]+") do
      current = path.join(current, part)
      local ok, err, code = stat.mkdir(current, opts.mode or 511)
      if not ok then
        if code ~= errno.EEXIST then checked(ok, err, code) end
        if fs.stat(current).type ~= "Directory" then M.fail("Not a directory: " .. current) end
      end
    end
  else
    checked(stat.mkdir(p, opts.mode or 511))
  end
end
function fs.remove(p, opts)
  opts = opts or {}
  local ok, v = pcall(fs.lstat, p)
  if not ok then
    if opts.force and M.missing(v) then return end
    error(v, 0)
  end
  if v.type == "Directory" then
    if opts.recursive then
      for _, name in ipairs(fs.readDirectory(p)) do
        fs.remove(path.join(p, name), opts)
      end
    end
    checked(unistd.rmdir(p))
  else
    checked(unistd.unlink(p))
  end
end
function fs.rename(a, b)
  local ok, err, code = os.rename(a, b)
  checked(ok, err, code)
end
function fs.copyFile(a, b, opts)
  opts = opts or {}
  fs.writeFileString(b, fs.readFileString(a), { flag = opts.flag or "wx", mode = opts.mode })
end
function fs.chmod(p, mode) return checked(stat.chmod(p, mode)) end
M.fs = fs
function M.getenv(name) return os.getenv(name) end
function M.setenv(name, value) return checked(stdlib.setenv(name, value, true)) end
function M.environment() return checked(stdlib.getenv()) end
function M.pid() return unistd.getpid() end
function M.hostname() return checked(uts.uname()).nodename end
function M.now() return system.monotime() end
function M.sleep(seconds) checked(system.sleep(seconds)) end
function M.uuid()
  local bytes = checked(system.random(16))
  local b = { bytes:byte(1, 16) }
  b[7] = (b[7] & 15) | 64
  b[9] = (b[9] & 63) | 128
  return string.format("%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", table.unpack(b))
end
function M.executable()
  local index = 0
  if not REX_WORKTREES_COMPILED then
    while arg[index - 1] do
      index = index - 1
    end
  end
  local name = arg[index]
  if type(name) ~= "string" or name == "" then M.fail("Cannot determine executable name") end
  if name:find("/", 1, true) then return fs.realPath(path.resolve(name)) end
  local search = os.getenv("PATH")
  if not search then M.fail("Cannot resolve executable " .. name .. ": PATH is not set") end
  for directory in (search .. ":"):gmatch("(.-):") do
    local candidate = path.resolve(directory ~= "" and directory or ".", name)
    local accessible, err, code = unistd.access(candidate, "x")
    if accessible then
      local info, statErr, statCode = stat.stat(candidate)
      if info and stat.S_ISREG(info.st_mode) ~= 0 then return fs.realPath(candidate) end
      if not info and statCode ~= errno.ENOENT and statCode ~= errno.ENOTDIR then checked(info, statErr, statCode) end
    elseif code ~= errno.ENOENT and code ~= errno.ENOTDIR and code ~= errno.EACCES then
      checked(accessible, err, code)
    end
  end
  M.fail("Cannot resolve executable " .. name .. " in PATH")
end
function M.command()
  if REX_WORKTREES_COMPILED then return { M.executable() } end
  return { M.executable(), fs.realPath(path.resolve(arg[0])) }
end
function M.exec(argv, opts)
  opts = opts or {}
  if opts.cwd then checked(unistd.chdir(opts.cwd)) end
  if opts.env then
    for k in pairs(M.environment()) do
      if opts.env[k] == nil then M.setenv(k, nil) end
    end
    for k, v in pairs(opts.env) do
      M.setenv(k, v)
    end
  end
  local args = {}
  for i = 2, #argv do
    args[#args + 1] = argv[i]
  end
  local _, err, code = unistd.execp(argv[1], args)
  checked(nil, err, code)
end
local function pipe()
  local rd, wr, code = unistd.pipe()
  if not rd then checked(rd, wr, code) end
  return rd, wr
end
function M.capture(argv, opts)
  opts = opts or {}
  local outR, outW, errR, errW, inR, inW
  if not opts.inherit then
    outR, outW = pipe()
    errR, errW = pipe()
    inR, inW = pipe()
  end
  local execR, execW = pipe()
  checked(fcntl.fcntl(execW, fcntl.F_SETFD, fcntl.FD_CLOEXEC))
  local pid = checked(unistd.fork())
  if pid == 0 then
    unistd.close(execR)
    if not opts.inherit then
      unistd.close(outR)
      unistd.close(errR)
      unistd.close(inW)
      unistd.dup2(outW, 1)
      unistd.dup2(errW, 2)
      unistd.dup2(inR, 0)
      unistd.close(outW)
      unistd.close(errW)
      unistd.close(inR)
    end
    local ok, err = pcall(M.exec, argv, opts)
    if not ok then
      unistd.write(execW, json.encode({ message = M.message(err), code = type(err) == "table" and err.code or nil }))
      unistd.write(2, M.message(err) .. "\n")
    end
    unistd._exit(127)
  end
  unistd.close(execW)
  local execError = unistd.read(execR, 65536)
  unistd.close(execR)
  local output, errors = {}, {}
  local start = M.now()
  local timed = false
  local status, code
  if not opts.inherit then
    unistd.close(outW)
    unistd.close(errW)
    unistd.close(inR)
    local descriptors = { [outR] = { events = { IN = true } }, [errR] = { events = { IN = true } } }
    local input = opts.stdin or ""
    local offset = 1
    if #input > 0 then
      descriptors[inW] = { events = { OUT = true } }
    else
      unistd.close(inW)
      inW = nil
    end
    while next(descriptors) do
      if opts.timeout and M.now() - start >= opts.timeout and not timed then
        signal.kill(pid, signal.SIGKILL)
        timed = true
      end
      local n, e, c = poll.poll(descriptors, 100)
      if not n and c ~= errno.EINTR then checked(n, e, c) end
      if n and n > 0 then
        for fd, entry in pairs(descriptors) do
          local r = entry.revents or {}
          if fd == inW and (r.OUT or r.ERR or r.HUP) then
            if r.OUT then
              local count, err, code = unistd.write(fd, input:sub(offset, offset + 4095))
              if count then
                offset = offset + count
              elseif code == errno.EPIPE then
                unistd.close(fd)
                descriptors[fd] = nil
                inW = nil
              elseif code ~= errno.EINTR then
                checked(count, err, code)
              end
            end
            if descriptors[fd] and (not r.OUT or offset > #input) then
              unistd.close(fd)
              descriptors[fd] = nil
              inW = nil
            end
          elseif fd ~= inW and (r.IN or r.HUP or r.ERR) then
            local data, err, code = unistd.read(fd, 65536)
            if not data and code ~= errno.EINTR then
              checked(data, err, code)
            elseif data == "" then
              unistd.close(fd)
              descriptors[fd] = nil
            elseif data then
              local t = fd == outR and output or errors
              t[#t + 1] = data
            end
          end
        end
      end
    end
  end
  if opts.timeout and not timed then
    while true do
      local result, s, c = wait.wait(pid, wait.WNOHANG)
      if not result then
        if c ~= errno.EINTR then checked(result, s, c) end
      elseif s ~= "running" then
        status, code = s, c
        break
      end
      if M.now() - start >= opts.timeout then
        signal.kill(pid, signal.SIGKILL)
        timed = true
        break
      end
      M.sleep(0.05)
    end
  end
  if not status then
    while true do
      local result, s, c = wait.wait(pid)
      if result then
        status, code = s, c
        break
      elseif c ~= errno.EINTR then
        checked(result, s, c)
      end
    end
  end
  if execError and execError ~= "" then
    local detail = json.decode(execError)
    M.fail(detail.message, { code = detail.code, program = argv[1] })
  end
  return {
    ok = status == "exited" and code == 0 and not timed,
    code = status == "exited" and code or 128 + (code or 0),
    signal = status == "killed" and code or nil,
    stdout = table.concat(output),
    stderr = table.concat(errors),
    timed_out = timed,
  }
end
function M.run(program, args, cwd, env)
  local argv = { program }
  for _, v in ipairs(args or {}) do
    argv[#argv + 1] = v
  end
  local r = M.capture(argv, { cwd = cwd, env = env })
  if not r.ok then
    M.fail(
      path.basename(program)
        .. " exited "
        .. r.code
        .. ": "
        .. ((r.stderr ~= "" and r.stderr or r.stdout):gsub("^%s+", ""):gsub("%s+$", "")),
      { program = program, args = args, exitCode = r.code, stdout = r.stdout, stderr = r.stderr }
    )
  end
  return r.stdout
end
local unicode = {}
function unicode.sanitize(text, preserveWhitespace)
  text = utf.clean(text)
  text = text:gsub("\27%[[0-?]*[ -/]*[@-~]", ""):gsub("\27%][^\7]*\7", "")
  local result = {}
  for _, cp in utf.codes(text) do
    if cp == 9 or cp == 10 or cp == 13 then
      result[#result + 1] = " "
    elseif
      not (
        cp < 32
        or cp == 127
        or (cp >= 128 and cp <= 159)
        or (cp >= 0x202a and cp <= 0x202e)
        or (cp >= 0x2066 and cp <= 0x2069)
        or cp == 0x200e
        or cp == 0x200f
        or cp == 0x061c
      )
    then
      result[#result + 1] = utf.char(cp)
    end
  end
  local value = table.concat(result)
  if not preserveWhitespace then value = value:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "") end
  return value
end
M.unicode = unicode
return M
