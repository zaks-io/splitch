import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/docs/static-output.build-check.ts"] },
});
