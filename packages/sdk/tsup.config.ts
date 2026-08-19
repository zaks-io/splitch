import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "react/index": "src/react/index.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: false,
  // The root entry stays dependency-free; React is an optional peer used only by ./react.
  external: ["react"],
});
