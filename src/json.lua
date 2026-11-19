local sax = require("lunajson.sax")
local encode = require("lunajson.encoder")()
local utf = require("lua-utf8")

local arrayMeta = {
  __jsontype = "array",
  __index = function(t, k)
    if k == 0 then return #t end
  end,
}
local objectMeta = { __jsontype = "object" }
local json = { null = {} }
function json.array(value) return setmetatable(value or {}, arrayMeta) end
function json.object(value) return setmetatable(value or {}, objectMeta) end
function json.encode(value) return encode(value, json.null) end
function json.decode(text)
  if not utf.isvalid(text) then error("Invalid UTF-8 in JSON") end
  local stack, root = {}, nil
  local function add(value)
    local frame = stack[#stack]
    if not frame then
      root = value
    elseif frame.key ~= nil then
      frame.value[frame.key] = value
      frame.key = nil
    else
      frame.value[#frame.value + 1] = value
    end
  end
  local function start(value)
    add(value)
    stack[#stack + 1] = { value = value }
  end
  local handlers = {
    startobject = function() start(json.object()) end,
    startarray = function() start(json.array()) end,
    endobject = function() stack[#stack] = nil end,
    endarray = function() stack[#stack] = nil end,
    key = function(value) stack[#stack].key = value end,
    string = add,
    number = add,
    boolean = add,
    null = function() add(json.null) end,
  }
  local parser = sax.newparser(text, handlers)
  parser.run()
  if text:sub(parser.tellpos()):find("[^ \t\r\n]") then error("Trailing JSON data") end
  return root
end
return json
