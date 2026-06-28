import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure-logic unit tests (reducers, helpers). No DOM needed → node env.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
