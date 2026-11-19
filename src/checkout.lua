local system = require("runtime")
local fs, path = system.fs, system.path

local function optionalStat(fn, name)
  local ok, value = system.try(function() return fn(name) end)
  if ok then return value end
  if system.missing(value) then return nil end
  error(value, 0)
end

local function inside(parent, child) return child == parent or child:sub(1, #parent + 1) == parent .. "/" end

local function planCheckoutPath(primaryPath, metadataDirectories, checkoutPaths, name, worktreeRoot)
  if worktreeRoot and not path.isAbsolute(worktreeRoot) then system.fail("Worktree root must be absolute") end
  local base = worktreeRoot and path.resolve(worktreeRoot) or primaryPath .. ".worktrees"
  local destination = path.resolve(base, name)
  if destination == base or not inside(base, destination) then
    system.fail("Worktree name escapes worktree directory")
  end
  for _, checkout in ipairs(checkoutPaths) do
    if inside(checkout, base) or inside(checkout, destination) then
      system.fail("Worktree root is inside checkout: " .. checkout)
    end
  end
  for _, metadata in ipairs(metadataDirectories) do
    if inside(metadata, base) or inside(metadata, destination) then
      system.fail("Worktree root is inside metadata directory: " .. metadata)
    end
  end
  local forbidden = {}
  if worktreeRoot then
    for _, list in ipairs({ checkoutPaths, metadataDirectories }) do
      for _, directory in ipairs(list) do
        local info = optionalStat(fs.stat, directory)
        if info then
          if not info.ino or not info.dev then system.fail("Cannot verify worktree root filesystem identity") end
          forbidden[#forbidden + 1] = info
        end
      end
    end
  end
  local part = "/"
  while true do
    local info = optionalStat(fs.lstat, part)
    if info and info.type == "SymbolicLink" then system.fail("Symlinked worktree path: " .. part) end
    if worktreeRoot and info and info.type == "Directory" and (not info.ino or not info.dev) then
      system.fail("Cannot verify worktree root filesystem identity")
    end
    if info then
      for _, entry in ipairs(forbidden) do
        if info.ino == entry.ino and info.dev == entry.dev then
          system.fail("Worktree root aliases a checkout or metadata directory: " .. part)
        end
      end
    end
    if part == destination then
      if info then system.fail("Worktree path already exists: " .. part) end
      break
    end
    if info and info.type ~= "Directory" then system.fail("Not a directory: " .. part) end
    local nextSlash = destination:find("/", #part + 2, true)
    part = nextSlash and destination:sub(1, nextSlash - 1) or destination
  end
  return destination
end

return { planCheckoutPath = planCheckoutPath }
