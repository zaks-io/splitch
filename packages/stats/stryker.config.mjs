import { strykerBase } from "../../stryker.base.mjs";

export default {
  ...strykerBase,
  mutate: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/**/*-test-helpers.ts",
    // ADR-0031: no barrels.
    "!src/index.ts",
  ],
  vitest: { configFile: "vitest.mutation.config.ts" },
};
