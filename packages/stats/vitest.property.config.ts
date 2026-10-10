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
    include: ["src/**/*.property.test.ts"],
    passWithNoTests: true,
  },
});
