import { defineConfig } from "vitest/config";

const runSlowTests = process.env.RUN_SLOW_TESTS === "true";

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Exclude E2E tests unless RUN_SLOW_TESTS is set
    exclude: runSlowTests ? [] : ["tests/e2e/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/index.ts"],
    },
    testTimeout: 10000,
  },
});
