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
  },
});
