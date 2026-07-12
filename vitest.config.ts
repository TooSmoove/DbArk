import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Pure-logic unit tests (reducers, helpers). No DOM needed → node env.
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests wire multiple modules across a faked IPC boundary and
    // run under their own config/gate (vitest.integration.config.ts) so the
    // unit gate stays a fast, pure-logic signal.
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
  },
});
