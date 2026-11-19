local system = require("runtime")
local fs, path, json = system.fs, system.path, system.json
local contracts = require("contracts")

local function stateRoot(root)
  root = root or system.getenv("XDG_STATE_HOME")
  if not root or root == "" then root = path.join(system.getenv("HOME") or "", ".local", "state") end
  if not path.isAbsolute(root) then system.fail("State home must be absolute") end
  return path.join(root, "rex-worktrees")
end

local function readOptional(filename)
  local ok, result = system.try(function() return fs.readFileString(filename) end)
  if ok then return result end
  if system.missing(result) then return nil end
  error(result, 0)
end

local function atomicWrite(filename, value)
  fs.makeDirectory(path.dirname(filename), { recursive = true, mode = 448 })
  local temporary = filename .. "." .. system.uuid() .. ".tmp"
  fs.writeFileString(temporary, json.encode(value), { flag = "wx", mode = 384 })
  local ok, err = system.try(function() fs.rename(temporary, filename) end)
  if not ok then
    local removed, removalError = system.try(function() fs.remove(temporary, { force = true }) end)
    if not removed then error(removalError, 0) end
    error(err, 0)
  end
end

local function rememberedCloneRoot(root)
  local raw = readOptional(path.join(stateRoot(root), "clone-root.json"))
  if not raw then return nil end
  local ok, record = system.try(function() return json.decode(raw) end)
  if
    ok
    and type(record) == "table"
    and type(record.cloneRoot) == "string"
    and path.isAbsolute(record.cloneRoot)
    and path.resolve(record.cloneRoot) == record.cloneRoot
  then
    return record.cloneRoot
  end
end

local function rememberCloneRoot(parent, root)
  if not path.isAbsolute(parent) or path.resolve(parent) ~= parent then
    system.fail("Clone parent must be normalized and absolute")
  end
  atomicWrite(path.join(stateRoot(root), "clone-root.json"), { cloneRoot = parent })
end

local function saveAssociation(association)
  contracts.validate("Association", association)
  local directory = path.join(stateRoot(), "associations")
  atomicWrite(path.join(directory, system.uuid() .. ".json"), association)
end

local function associations()
  local directory = path.join(stateRoot(), "associations")
  local result = json.array()
  if not fs.exists(directory) then return result end
  for _, name in ipairs(fs.readDirectory(directory)) do
    if name:sub(-5) == ".json" then
      local raw = readOptional(path.join(directory, name))
      if raw then
        local ok, value = system.try(function() return contracts.decode("Association", raw) end)
        if ok then result[#result + 1] = value end
      end
    end
  end
  return result
end

return {
  rememberedCloneRoot = rememberedCloneRoot,
  rememberCloneRoot = rememberCloneRoot,
  saveAssociation = saveAssociation,
  associations = associations,
}
