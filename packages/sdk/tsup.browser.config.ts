import { defineConfig } from "tsup";

/** Shared graph for the browser client and its optional React binding. */
export default defineConfig({
  entry: {
    "browser/index": "src/browser/index.ts",
    "react/index": "src/react/index.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  bundle: true,
  splitting: true,
  clean: false,
  sourcemap: false,
  external: ["react", "@splitch/sdk/browser"],
});
