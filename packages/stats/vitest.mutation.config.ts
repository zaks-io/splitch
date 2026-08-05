import { defineConfig } from "vitest/config";

/**
 * Stryker runs the suite from a sandbox copy of the package, so this config
 * deliberately differs from the others in two ways.
 *
 * It drops the `@splitch/contracts` source alias: the alias is resolved
 * relative to the config file, which no longer sits beside `packages/`. The
 * package's own exports map already points at source, so plain resolution
 * through the symlinked node_modules is both sufficient and sandbox-proof.
 *
 * It excludes the Monte Carlo simulations, whose signal is a realized error
 * rate over thousands of trials rather than a claim a single mutant can answer,
 * and the verify:ci wiring contract, which reads the repo root package.json by
 * relative path and has nothing to say about a mutated statistic.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["src/**/*.simulation.test.ts", "src/verify-ci-contract.test.ts"],
    passWithNoTests: true,
  },
});
