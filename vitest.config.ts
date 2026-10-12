import { defineConfig } from "vitest/config";

// Two projects. `spec` tests run against the running app, which
// spec/global-setup.ts finds; CI points them at the built image. `engine` tests
// are unit tests of the pure game engine and need no app, so they carry no
// globalSetup. Only src/ and spec/ run: a test anywhere else needs adding to an
// `include`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "engine",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "spec",
          include: ["spec/**/*.test.ts"],
          globalSetup: ["./spec/global-setup.ts"],
        },
      },
    ],
  },
});
