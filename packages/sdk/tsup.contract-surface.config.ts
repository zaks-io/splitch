import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "contract-surface": "scripts/contract-surface-entry.ts",
  },
  outDir: "src/generated",
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: false,
  // Zod-free validators: do not externalize or bundle zod.
  external: [],
  tsconfig: "tsconfig.contract-surface.json",
});
