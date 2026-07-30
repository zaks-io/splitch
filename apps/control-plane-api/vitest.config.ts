import { defineConfig } from "vitest/config";

// The unit and Workers-pool suites used to run as two sequential `vitest run`
// invocations; projects let one run schedule both concurrently.
export default defineConfig({
  test: {
    projects: ["./vitest.config.unit.ts", "./vitest.config.workers.ts"],
  },
});
