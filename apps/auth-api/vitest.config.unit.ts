import { defineConfig } from "vitest/config";
import { D1_TEST_FILES } from "./vitest.d1-tests";

export default defineConfig({
  test: {
    name: "unit",
    include: ["src/**/*.{test,spec}.ts"],
    exclude: D1_TEST_FILES,
    passWithNoTests: true,
  },
});
