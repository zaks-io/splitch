import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    // 15s, matching every other workspace config. The surface-discovery suites
    // build a real TypeScript `Program` per case, which runs ~250ms locally and
    // ~2s on a loaded CI runner, so the 5s default left no margin and timed one
    // case out under load.
    testTimeout: 15_000,
  },
});
