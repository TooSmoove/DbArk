import { defineConfig } from "vitest/config";

// Module-integration tests: the real query pipeline (ipc → parse → reshape →
// reducers) wired together across a faked Tauri IPC boundary. Kept in a
// separate project from the unit gate so a slower/broader suite can grow here
// without diluting the "one pure function" unit tests. Same node env — these
// exercise logic seams, not the DOM.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
  },
});
