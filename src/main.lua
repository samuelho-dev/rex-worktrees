local system = require("runtime")
local contracts = require("contracts")
local client = require("client")
local rex = require("rex")
local path = system.path
local help = [=[rex-worktrees — Git worktrees and JJ workspaces on existing Rex machines
  setup [--bin /absolute/path/rex-worktrees] [--config /absolute/path/init.lua]
                                         install Lua module; copy binary to ~/.local/bin unless --bin is set
  chooser                                read a JSON chooser request on stdin, write a JSON response
  open --repo PATH --session ID --name NAME (--branch NAME | --worktree PATH) [--worktree-name NAME]
                                         Git: branch checkout or existing worktree
  open --repo PATH --session ID --name NAME (--worktree PATH | --worktree-name NAME --revision EXPR)
                                         JJ: existing workspace or new workspace at base revision
       [--host HOST] [--client ID] [--additional | --split]
  host-request                            read a JSON request on stdin, write a JSON response
  help

--host selects an existing Rex host label or registry ID. Install setup separately on each destination.]=]
local booleans = { ["--additional"] = true, ["--split"] = true }
local strings = {
  ["--bin"] = true,
  ["--config"] = true,
  ["--host"] = true,
  ["--repo"] = true,
  ["--session"] = true,
  ["--name"] = true,
  ["--branch"] = true,
  ["--revision"] = true,
  ["--worktree"] = true,
  ["--worktree-name"] = true,
  ["--client"] = true,
}
local function parseFlags(args)
  local flags, index = {}, 1
  while index <= #args do
    local flag = args[index]
    if flags[flag] ~= nil then system.fail("Duplicate flag: " .. flag) end
    if booleans[flag] then
      flags[flag] = true
    elseif strings[flag] then
      index = index + 1
      local value = args[index]
      if not value or value == "" or value:sub(1, 2) == "--" then system.fail("Missing value for " .. flag) end
      if flag == "--session" then
        contracts.validate("SessionId", value)
      elseif flag == "--client" then
        contracts.validate("ClientId", value)
      end
      flags[flag] = value
    else
      system.fail("Unknown flag: " .. flag)
    end
    index = index + 1
  end
  return flags
end
local function only(flags, allowed, message)
  for flag in pairs(flags) do
    if not allowed[flag] then system.fail(message) end
  end
end
local function machineFor(selected)
  for _, machine in ipairs(client.listMachines()) do
    if
      not selected and machine["local"]
      or selected and (machine.key == selected or machine.label == selected or machine.selector == selected)
    then
      return machine
    end
  end
end
local function main()
  local argv = {}
  for i = 1, #arg do
    argv[i] = arg[i]
  end
  local verb = table.remove(argv, 1) or "help"
  if verb == "help" or verb == "--help" or verb == "-h" then
    print(help)
    return
  end
  if verb == "setup" then
    local flags = parseFlags(argv)
    only(flags, { ["--bin"] = true, ["--config"] = true }, "Invalid setup flags: --config requires --bin")
    if flags["--config"] and not flags["--bin"] then system.fail("Invalid setup flags: --config requires --bin") end
    if not REX_WORKTREES_COMPILED then
      system.fail("Build first with make build, then run the packaged rex-worktrees executable for setup")
    end
    local installed = require("setup").setup(flags["--bin"], flags["--config"])
    print(
      "Default binary: "
        .. installed.bin
        .. "\nInstalled Lua module: "
        .. installed.luaPath
        .. "\nRex config: "
        .. installed.configPath
        .. (installed.migrated and "\nMigrated legacy JSON settings to Rex Lua; removed legacy files." or "")
        .. (
          flags["--config"]
            and "\nReload the targeted Rex config to activate, or start that instance if it is stopped."
          or "\nRun rex config reload to activate."
        )
    )
    return
  end
  local executable = system.command()
  if verb == "chooser" then
    if #argv > 0 then system.fail("chooser reads JSON from stdin") end
    local raw = io.read("*a")
    if not raw then system.fail("Failed reading stdin") end
    local request = contracts.decode("ChooserRequest", raw)
    print(system.json.encode(require("chooser").request(request, executable)))
    return
  end
  if verb == "open" then
    local flags = parseFlags(argv)
    if flags["--bin"] then system.fail("--bin is only supported by setup") end
    if not flags["--repo"] or not flags["--session"] or not flags["--name"] then
      system.fail("open requires --repo PATH --session ID --name NAME")
    end
    if flags["--additional"] and flags["--split"] then
      system.fail("--additional and --split are mutually exclusive")
    end
    local machine = machineFor(flags["--host"])
    if not machine then system.fail("Rex host " .. tostring(flags["--host"]) .. " is not registered") end
    local host = client.connectMachine(machine)
    if
      not host["local"]
      and (not path.isAbsolute(flags["--repo"]) or (flags["--worktree"] and not path.isAbsolute(flags["--worktree"])))
    then
      system.fail("Remote repository and worktree paths must be absolute on the destination machine")
    end
    local repo = host["local"] and path.resolve(flags["--repo"]) or flags["--repo"]
    local vcs = host["local"] and require("repositories").repository(repo).vcs
      or client.inspectProject(host, executable, repo).checkout.vcs
    local input = {
      vcs = vcs,
      repo = repo,
      session = { kind = "existing", id = flags["--session"] },
      name = flags["--name"],
      worktreeName = flags["--worktree-name"],
      path = flags["--worktree"] and (host["local"] and path.resolve(flags["--worktree"]) or flags["--worktree"]),
      clientId = flags["--client"],
      additional = flags["--additional"],
      split = flags["--split"],
    }
    if vcs == "git" then
      if flags["--revision"] or (not not flags["--branch"]) == not not flags["--worktree"] then
        system.fail("Git requires exactly one of --branch NAME or --worktree PATH; --revision is JJ-only")
      end
      if flags["--worktree-name"] and flags["--worktree"] then
        system.fail("--worktree-name requires --branch, not --worktree")
      end
      input.branch = flags["--branch"]
    else
      if
        flags["--branch"]
        or (not not flags["--worktree"]) == not not flags["--worktree-name"]
        or (flags["--worktree"] and flags["--revision"])
        or (flags["--worktree-name"] and not flags["--revision"])
      then
        system.fail("JJ requires --worktree PATH or --worktree-name NAME with --revision EXPR; --branch is Git-only")
      end
      input.revision = flags["--revision"]
    end
    local reviewed = client.review(host, executable, input)
    print(system.json.encode(client.submit(host, executable, input, reviewed)))
    return
  end
  if verb == "task" or verb == "clone-task" then
    if #argv ~= 1 then system.fail(verb .. " requires one JSON argument") end
    local request = contracts.decode(verb == "task" and "TaskRequest" or "CloneTaskRequest", argv[1])
    local worktrees = require("worktrees")
    if verb == "task" then
      worktrees.task(request)
    else
      worktrees.cloneTask(request)
    end
    return
  end
  if verb == "host-request" then
    if #argv > 0 then system.fail("host-request reads JSON from stdin") end
    local raw = io.read("*a")
    if not raw then system.fail("Failed reading stdin") end
    print(system.json.encode(require("host").hostRequest(raw, executable)))
    return
  end
  system.fail("Unknown command: " .. verb .. "\n" .. help)
end
local ok, err = system.try(main)
if not ok then
  io.stderr:write(system.message(err), "\n")
  os.exit(1)
end
