import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tools/**/*.test.ts"],
    exclude: ["node_modules"],
    setupFiles: ["tools/oxlint/rule-tester-setup.ts"],
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["src/integrations/opencode2/node_modules/**"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: { lines: 95, statements: 95, functions: 85, branches: 85 },
    },
  },
});
