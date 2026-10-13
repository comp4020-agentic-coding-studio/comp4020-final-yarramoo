import { defineConfig } from "vitest/config";

// Determinism suite: no running server needed (unlike vitest.config.ts / spec/).
export default defineConfig({
  test: {
    include: ["tests/determinism/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
