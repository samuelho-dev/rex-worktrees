-- rex-worktrees: managed module
local installed_rex_bin_dir = false
local installed_path_env = false
local installed_bin = false
local installed_config_dir = false
-- Opening is opt-in via opts.key.
local M = {}

function M.setup(opts)
  opts = opts or {}
  local rex_bin_dir = opts.rex_bin_dir or installed_rex_bin_dir or os.getenv("REX_BIN_DIR")
  if rex_bin_dir and (type(rex_bin_dir) ~= "string" or rex_bin_dir:sub(1, 1) ~= "/") then
    error("rex-worktrees: rex_bin_dir must be an absolute directory", 0)
  end
  local home = os.getenv("HOME")
  local bin = opts.bin or installed_bin or (home and home .. "/.local/bin/rex-worktrees")
  if type(bin) ~= "string" or bin:sub(1, 1) ~= "/" then
    error("rex-worktrees: set HOME or provide an absolute bin path", 0)
  end
  local rex_config = os.getenv("REX_CONFIG")
  local config_dir = installed_config_dir or (rex_config and (rex_config:match("^(.+)/[^/]+$") or (rex_config:match("^/[^/]+$") and "/") or rex_config))
    or (os.getenv("XDG_CONFIG_HOME") and os.getenv("XDG_CONFIG_HOME") .. "/rex")
    or (home and home .. "/.config/rex")
  if type(config_dir) ~= "string" or config_dir:sub(1, 1) ~= "/" then
    error("rex-worktrees: Rex config directory must be absolute", 0)
  end
  local config = { roots = opts.roots, projects = opts.projects, worktreeRoot = opts.worktreeRoot }
  if type(config.roots) == "table" and next(config.roots) == nil then config.roots = nil end
  if type(config.projects) == "table" and next(config.projects) == nil then config.projects = nil end
  local settings = rex.json.encode({ config = config, directory = config_dir })

  local function exec_options(stdin)
    local options = { stdin = stdin, timeout = 20, env = { REX_WORKTREES_CONFIG = settings } }
    if rex_bin_dir then options.env.REX_BIN_DIR = rex_bin_dir end
    if installed_path_env ~= false then options.env.PATH = installed_path_env end
    options.env.REX_WORKTREES_LOCAL_ENDPOINT = os.getenv("REX_WORKTREES_LOCAL_ENDPOINT")
    return options
  end

  local function worktrees_request(request)
    local result, run_err = rex.exec({ bin, "host-request" }, exec_options(request))
    if not result then error(run_err, 0) end
    if not result.ok then
      error("rex-worktrees host-request failed (exit " .. tostring(result.code)
        .. ", signal " .. tostring(result.signal) .. "): "
        .. ((result.stderr and result.stderr ~= "") and result.stderr or result.stdout or ""), 0)
    end
    -- Keep JSON opaque: Lua tables discard JSON null and cannot round-trip empty arrays.
    return result.stdout
  end

  rex.action{
    name = "worktrees_request",
    title = "Request destination-local worktree operations",
    description = "Validate a versioned worktree request and run it on this Rex machine",
    args = { request = "string" },
    run = function(_, args)
      return worktrees_request(args.request)
    end,
  }

  rex.action{
    name = "worktrees_config",
    title = "Read this machine's worktree settings",
    description = "Return destination-local settings to standalone rex-worktrees commands",
    run = function() return settings end,
  }

  local function chooser(request)
    local result, run_err = rex.exec({ bin, "chooser" }, exec_options(rex.json.encode(request)))
    if not result then error("rex-worktrees chooser: " .. tostring(run_err), 0) end
    if not result.ok then
      error("rex-worktrees chooser failed: " ..
        ((result.stderr and result.stderr ~= "") and result.stderr or result.stdout or ""), 0)
    end
    local response, decode_err = rex.json.decode(result.stdout)
    if type(response) ~= "table" then
      error("rex-worktrees chooser returned invalid JSON: " .. tostring(decode_err), 0)
    end
    if response.error ~= nil and type(response.error) ~= "string" or
      response.notice ~= nil and type(response.notice) ~= "string" or
      response.done ~= nil and type(response.done) ~= "boolean" then
      error("rex-worktrees chooser returned invalid status", 0)
    end
    if response.done then
      if response.result ~= nil and type(response.result) ~= "table" then
        error("rex-worktrees chooser returned invalid result", 0)
      end
      return response
    end
    if type(response.state) ~= "string" or type(response.rows) ~= "table" or #response.rows ~= 7 or
      type(response.submitLabel) ~= "string" or type(response.submitDisabled) ~= "boolean" then
      error("rex-worktrees chooser returned invalid summary", 0)
    end
    local fields = { project = true, machine = true, session = true, destination = true,
      branch = true, checkoutName = true, mode = true }
    local seen = {}
    for _, row in ipairs(response.rows) do
      if type(row) ~= "table" or not fields[row.id] or seen[row.id] or
        type(row.label) ~= "string" or type(row.value) ~= "string" or
        row.detail ~= nil and type(row.detail) ~= "string" or
        row.disabled ~= nil and type(row.disabled) ~= "boolean" or
        row.isReadOnly ~= nil and type(row.isReadOnly) ~= "boolean" then
        error("rex-worktrees chooser returned invalid row", 0)
      end
      seen[row.id] = true
    end
    local editor = response.editor
    if editor ~= nil then
      if type(editor) ~= "table" or (editor.kind ~= "pick" and editor.kind ~= "input") or
        type(editor.title) ~= "string" or type(editor.items) ~= "table" or
        type(editor.allowOther) ~= "boolean" or
        editor.value ~= nil and type(editor.value) ~= "string" then
        error("rex-worktrees chooser returned invalid editor", 0)
      end
      local ids = {}
      for _, item in ipairs(editor.items) do
        if type(item) ~= "table" or type(item.id) ~= "string" or ids[item.id] or
          type(item.title) ~= "string" or
          item.subtitle ~= nil and type(item.subtitle) ~= "string" or
          item.detail ~= nil and type(item.detail) ~= "string" then
          error("rex-worktrees chooser returned invalid editor item", 0)
        end
        ids[item.id] = true
      end
    end
    if response.confirmation ~= nil and
      (type(response.confirmation) ~= "table" or type(response.confirmation.title) ~= "string" or
        type(response.confirmation.detail) ~= "string") then
      error("rex-worktrees chooser returned invalid confirmation", 0)
    end
    return response
  end

  local function no_answer(why, detail)
    if why == "cancelled" then return end
    error("rex-worktrees prompt failed: " .. tostring(why) ..
      (detail and (": " .. tostring(detail)) or ""), 0)
  end

  rex.action{
    name = "worktrees_open",
    title = "Open Worktree…",
    description = "Choose a project, Rex machine, checkout, and exact session",
    run = function(ctx)
      if type(rex.ui) ~= "table" or type(rex.ui.pick) ~= "function" or type(rex.ui.input) ~= "function" then
        error("rex-worktrees requires Rex control API revision 17 or newer with native UI prompts; upgrade Rex and its connected app", 0)
      end
      local session_id = ctx.session_id or (not ctx.server and rex.session_id)
      if type(session_id) ~= "string" then error("Select a Rex session first", 0) end
      local response = chooser({ op = "start", origin = {
        sessionId = session_id,
        blockId = ctx.block_id or (not ctx.server and session_id == rex.session_id and rex.block_id or nil),
        clientId = ctx.client_id,
        server = ctx.server,
      } })
      while true do
        if response.done then
          if response.error then error(response.error, 0) end
          if response.notice then
            local acknowledged, why, detail = rex.ui.pick{
              title = response.notice, items = { { id = "ok", title = "OK" } },
            }
            if acknowledged == nil then no_answer(why, detail)
            elseif acknowledged ~= "ok" then error("rex-worktrees prompt returned an invalid acknowledgement", 0) end
          end
          return response.result
        end
        local request = { state = response.state }
        if response.confirmation then
          local choice, why, detail = rex.ui.pick{
            title = response.confirmation.title,
            items = { { id = "confirm", title = "Continue", subtitle = response.confirmation.detail } },
          }
          if choice == nil then
            no_answer(why, detail)
            request.op = "cancel"
          elseif choice == "confirm" then
            request.op = "confirm"
          else
            error("rex-worktrees prompt returned an invalid confirmation", 0)
          end
        elseif response.editor then
          local editor = response.editor
          local answer, why, detail
          if editor.kind == "input" then
            answer, why, detail = rex.ui.input{ title = editor.title, value = editor.value }
            if answer ~= nil then request.text = answer end
          else
            local page, page_size = 1, 1998
            while true do
              local items, choices = {}, {}
              local first = (page - 1) * page_size + 1
              local last = math.min(first + page_size - 1, #editor.items)
              if page > 1 then items[#items + 1] = { id = "previous", title = "Previous page" } end
              for i = first, last do
                local item, id = editor.items[i], "item:" .. i
                items[#items + 1] = { id = id, title = item.title, subtitle = item.subtitle, detail = item.detail }
                choices[id] = item.id
              end
              if last < #editor.items then items[#items + 1] = { id = "next", title = "Next page" } end
              answer, why, detail = rex.ui.pick{
                title = #editor.items > page_size and (editor.title .. " (" .. page .. "/" ..
                  math.ceil(#editor.items / page_size) .. ")") or editor.title,
                items = items, allow_other = editor.allowOther, value = editor.value,
              }
              if answer == "previous" then
                page = page - 1
              elseif answer == "next" then
                page = page + 1
              else
                if type(answer) == "table" and editor.allowOther and type(answer.text) == "string" then
                  request.text = answer.text
                elseif answer ~= nil then
                  request.id = choices[answer]
                  if request.id == nil then error("rex-worktrees prompt returned an invalid choice", 0) end
                end
                break
              end
            end
          end
          if answer == nil then
            no_answer(why, detail)
            request.op = "cancel"
          else
            if request.text ~= nil and type(request.text) ~= "string" then
              error("rex-worktrees prompt returned invalid text", 0)
            end
            request.op = "accept"
          end
        else
          local items, rows = {}, {}
          for _, row in ipairs(response.rows) do
            local status = row.disabled and "Disabled" or (row.isReadOnly and "Read only" or nil)
            items[#items + 1] = {
              id = "field:" .. row.id, title = row.label .. ": " .. row.value,
              subtitle = row.detail, detail = status,
            }
            rows["field:" .. row.id] = row
          end
          if not response.submitDisabled then
            items[#items + 1] = { id = "submit", title = response.submitLabel }
          end
          local title = response.error or response.notice or "Open Worktree"
          local choice, why, detail = rex.ui.pick{
            title = title, items = items, allow_other = true,
            placeholder = "Type a new worktree name, or select a setting", confirm = "Create & open",
          }
          if choice == nil then no_answer(why, detail); return end
          if type(choice) == "table" and type(choice.text) == "string" then
            request.op, request.text = "submit", choice.text
          elseif choice == "submit" and not response.submitDisabled then
            request.op = "submit"
          elseif rows[choice] then
            local row = rows[choice]
            if not row.disabled and not row.isReadOnly then
              request.op, request.field = "edit", row.id
            end
          else
            error("rex-worktrees prompt returned an invalid field", 0)
          end
        end
        if request.op then response = chooser(request) end
      end
    end,
  }


  if opts.key then rex.bind(opts.key, "worktrees_open") end
end

-- `rex do /absolute/path/rex-worktrees.lua --action worktrees_open bin=/absolute/bin`
if rex.args then
  M.setup({ bin = rex.args.bin, rex_bin_dir = rex.args.rex_bin_dir })
else
  return M
end
