import { readFile } from "node:fs/promises"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [{
    name: "lua-text-import",
    async load(id) {
      if (id.endsWith(".lua")) return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
    }
  }],
  test: {
    // Real Git/JJ and PTY subprocess tests need a bounded integration budget, without competing suites.
    fileParallelism: false,
    testTimeout: 30_000
  }
})
