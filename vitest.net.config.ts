import { defineConfig } from "vitest/config";

// Networking tests: no global setup and no external server (the two-client test starts its own).
export default defineConfig({
  test: {
    include: ["tests/net/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
