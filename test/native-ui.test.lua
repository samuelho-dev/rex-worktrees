return function()
  local old_rex = rex
  local actions, pending, calls = {}, nil, {}
  local rows = {}
  for _, id in ipairs({ "project", "machine", "session", "destination", "branch", "checkoutName", "mode" }) do
    rows[#rows + 1] = { id = id, label = id, value = id, isReadOnly = id == "branch" }
  end
  local function summary(state, editor)
    return { state = state, rows = rows, submitLabel = "Open", submitDisabled = false, editor = editor }
  end
  local pick_count, quick = 0, false
  rex = {
    session_id = "local-session", block_id = "local-block",
    json = {
      encode = function(value) pending = value; return "encoded" end,
      decode = function() return pending end,
    },
    action = function(action) actions[action.name] = action.run end,
    bind = function() end,
    exec = function(command, options)
      assert(command[1] == "/test/rex-worktrees" and command[2] == "chooser")
      assert(options.stdin == "encoded")
      local request = pending
      calls[#calls + 1] = request
      if request.op == "start" then
        assert(request.origin.sessionId == "remote-session" and request.origin.server == "remote")
        assert(request.origin.blockId == "remote-block" and request.origin.clientId == "client")
        pending = summary("draft-1")
      elseif request.op == "edit" then
        assert(request.field == "destination" and request.state == "draft-1")
        pending = summary("editor-1", { kind = "pick", title = "Worktree", allowOther = false,
          items = { { id = "new", title = "Create" } } })
      elseif request.op == "accept" then
        assert(request.state == "editor-1" and request.id == "new")
        pending = summary("editor-2", { kind = "input", title = "Branch", allowOther = true,
          value = "feature", items = {} })
      elseif request.op == "cancel" then
        assert(request.state == "editor-2")
        pending = summary("draft-2")
      elseif request.op == "submit" then
        assert(request.state == (quick and "draft-1" or "draft-2"))
        if quick then assert(request.text == "new-feature") end
        pending = { done = true, result = { opened = true } }
      else error("unexpected operation " .. tostring(request.op)) end
      return { ok = true, stdout = "response" }
    end,
    ui = {
      pick = function(prompt)
        pick_count = pick_count + 1
        if quick then return { text = "new-feature" } end
        if pick_count == 1 then
          assert(#prompt.items == 8 and prompt.items[5].detail == "Read only")
          return "field:branch"
        elseif pick_count == 2 then return "field:destination"
        elseif pick_count == 3 then return "item:1"
        elseif pick_count == 4 then return "submit" end
        error("unexpected picker")
      end,
      input = function(prompt)
        assert(prompt.title == "Branch" and prompt.value == "feature")
        return nil, "cancelled"
      end,
    },
  }
  local module = dofile("lua/rex-worktrees.lua")
  module.setup({ bin = "/test/rex-worktrees" })
  local result = actions.worktrees_open({ session_id = "remote-session", block_id = "remote-block",
    client_id = "client", server = "remote" })
  assert(result.opened and #calls == 5 and calls[5].op == "submit")
  quick = true
  result = actions.worktrees_open({ session_id = "remote-session", block_id = "remote-block",
    client_id = "client", server = "remote" })
  assert(result.opened and calls[#calls].op == "submit" and calls[#calls].text == "new-feature")
  rex = old_rex
end
