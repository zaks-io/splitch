import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "component/convex.config": "src/component/convex.config.ts",
    "component/schema": "src/component/schema.ts",
    "component/evaluation": "src/component/evaluation.ts",
    "component/integration": "src/component/integration.ts",
    "component/http": "src/component/http.ts",
    "component/_generated/component": "src/component/_generated/component.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  bundle: true,
  splitting: true,
  clean: true,
  sourcemap: false,
  external: ["convex", "convex/server", "convex/values"],
});
