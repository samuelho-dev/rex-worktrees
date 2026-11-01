-- rex-worktrees: managed module
local installed_rex_bin_dir = false
local installed_path_env = false
-- Opening is opt-in via opts.key.
local M = {}

function M.setup(opts)
  opts = opts or {}
  local rex_bin_dir = opts.rex_bin_dir or installed_rex_bin_dir or os.getenv("REX_BIN_DIR")
  if rex_bin_dir and (type(rex_bin_dir) ~= "string" or rex_bin_dir:sub(1, 1) ~= "/") then
    error("rex-worktrees: rex_bin_dir must be an absolute directory", 0)
  end
  local home = os.getenv("HOME")
  local bin = opts.bin or (home and home .. "/.local/bin/rex-worktrees")
  if type(bin) ~= "string" or bin:sub(1, 1) ~= "/" then
    error("rex-worktrees: set HOME or provide an absolute bin path", 0)
  end

  local function worktrees_request(request)
    local exec_opts = { stdin = request, timeout = 20, env = {} }
    if rex_bin_dir then exec_opts.env.REX_BIN_DIR = rex_bin_dir end
    if installed_path_env ~= false then exec_opts.env.PATH = installed_path_env end
    if os.getenv("REX_WORKTREES_LOCAL_ENDPOINT") then exec_opts.env.REX_WORKTREES_LOCAL_ENDPOINT = os.getenv("REX_WORKTREES_LOCAL_ENDPOINT") end
    local result, run_err = rex.exec({ bin, "host-request" }, exec_opts)
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
    name = "worktrees_open",
    title = "Open Worktree…",
    description = "Choose a project, Rex machine, checkout, and exact session",
    run = function(ctx)
      local session_id = ctx.session_id or rex.session_id
      if type(session_id) ~= "string" then error("Select a Rex session first", 0) end
      local command = { bin, "launch-popup", "--session", session_id }
      local block_id = ctx.block_id or (session_id == rex.session_id and rex.block_id or nil)
      if type(block_id) == "string" then
        table.insert(command, "--origin-block")
        table.insert(command, block_id)
      else
        table.insert(command, "--no-context")
      end
      if type(ctx.client_id) == "string" then
        table.insert(command, "--origin-client")
        table.insert(command, ctx.client_id)
      end
      local exec_opts = { timeout = 20, env = {} }
      if rex_bin_dir then exec_opts.env.REX_BIN_DIR = rex_bin_dir end
      if installed_path_env ~= false then exec_opts.env.PATH = installed_path_env end
      if os.getenv("REX_WORKTREES_LOCAL_ENDPOINT") then exec_opts.env.REX_WORKTREES_LOCAL_ENDPOINT = os.getenv("REX_WORKTREES_LOCAL_ENDPOINT") end
      local result, run_err = rex.exec(command, exec_opts)
      if not result then error(run_err, 0) end
      if not result.ok then
        error("rex-worktrees launch-popup failed: " ..
          ((result.stderr and result.stderr ~= "") and result.stderr or result.stdout or ""), 0)
      end
      local layer, decode_err = rex.json.decode(result.stdout)
      if not layer or type(layer.layer_id) ~= "string" or type(layer.block_ids) ~= "table" or
        type(layer.block_ids[1]) ~= "string" then
        error("rex-worktrees launch-popup returned invalid JSON: " .. tostring(decode_err or result.stdout), 0)
      end
      return layer
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
