local git, jj = require("git"), require("jj")
git.cloneRepository(arg[1], arg[2])
jj.cloneRepository(arg[1], arg[3])
