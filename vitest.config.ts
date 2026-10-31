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
    // Git integration fixtures spawn many processes; competing suites can exhaust the 5s per-test deadline.
    fileParallelism: false
  }
})
