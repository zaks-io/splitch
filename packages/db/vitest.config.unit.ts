import { defineConfig } from "vitest/config";
import { D1_TEST_FILES } from "./vitest.d1-tests";

export default defineConfig({
  test: {
    name: "unit",
    include: ["src/**/*.{test,spec}.ts"],
    exclude: D1_TEST_FILES,
    // The verify graph runs many vitest processes at once; Miniflare full-schema
    // applies exceed the 5s default under that CPU contention.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
