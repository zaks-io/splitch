import { defineConfig } from "tsup";

/** Second entry for `@splitch/sdk/browser`. Runs after the root build (no clean). */
export default defineConfig({
  entry: { "browser/index": "src/browser/index.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  bundle: true,
  splitting: false,
  clean: false,
  sourcemap: false,
  external: [],
});
