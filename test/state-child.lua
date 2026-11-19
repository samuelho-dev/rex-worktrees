local state = require("state")
local home = assert(os.getenv("HOME"))
state.rememberCloneRoot(home .. "/parent")
assert(state.rememberedCloneRoot() == home .. "/parent")
