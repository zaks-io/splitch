import { strykerBase } from "../../stryker.base.mjs";

export default {
  ...strykerBase,
  mutate: ["src/**/*.ts", "!src/**/*.test.ts"],
};
