import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", worker: "src/worker.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  bundle: true,
  splitting: true,
  clean: true,
  sourcemap: false,
  external: ["cloudflare:workers"],
});
