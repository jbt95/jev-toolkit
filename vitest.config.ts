import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "core/**/*.test.ts",
      "cli/**/*.test.ts",
      "audit/**/*.test.ts",
      "question-packs/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["node_modules", "tools"],
  },
});
