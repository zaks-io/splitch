import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@splitch/contracts/testing": fileURLToPath(
        new URL("../contracts/src/testing/index.ts", import.meta.url),
      ),
      "@splitch/contracts": fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.simulation.test.ts"],
    // CPU-bound Monte Carlo loops need predictable runtimes on the 2-vCPU audit runner.
    maxWorkers: 1,
    passWithNoTests: true,
  },
});
