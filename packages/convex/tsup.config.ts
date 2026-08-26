import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "react/index": "src/react/index.ts",
    "component/convex.config": "src/component/convex.config.ts",
    "component/schema": "src/component/schema.ts",
    "component/evaluation": "src/component/evaluation.ts",
    "component/integration": "src/component/integration.ts",
    "component/http": "src/component/http.ts",
    "component/retention": "src/component/retention.ts",
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
  external: [
    /^@splitch\/sdk(?:\/.*)?$/,
    "convex",
    "convex/react",
    "convex/server",
    "convex/values",
    "react",
  ],
});
