/**
 * Shared Stryker base. Per-package `stryker.config.mjs` spreads this and sets
 * `mutate`. Policy lives in docs/adr/0031.
 *
 * This is a module rather than JSON because Stryker has no `extends`: it reads
 * a JSON config verbatim and silently ignores keys it does not know, so a base
 * file referenced that way never applies. A spread is the composition Stryker
 * actually supports.
 */
import { fileURLToPath } from "node:url";

/**
 * Stryker globs its default `@stryker-mutator/*` plugin expression against its
 * own directory in the pnpm store, which holds only core. Every dev dependency
 * in this repo lives at the workspace root, so the plugins are resolved from
 * here, where they actually are, and handed over as absolute paths.
 */
const plugins = ["@stryker-mutator/vitest-runner", "@stryker-mutator/typescript-checker"].map(
  (specifier) => fileURLToPath(import.meta.resolve(specifier)),
);

export const strykerBase = {
  packageManager: "pnpm",
  plugins,
  testRunner: "vitest",
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  coverageAnalysis: "perTest",
  reporters: ["html", "clear-text", "progress"],
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  // Sandbox contents, not mutation scope: the tests have to be copied in or
  // there is nothing to run. `mutate` is what keeps them from being mutated.
  ignorePatterns: ["dist", "coverage", ".turbo"],
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
};
