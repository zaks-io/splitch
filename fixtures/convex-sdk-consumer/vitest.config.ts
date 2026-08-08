import { defineConfig } from "vitest/config";

// Match Convex's default isolate as closely as Vitest allows.
// https://docs.convex.dev/testing/convex-test
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
  },
});
