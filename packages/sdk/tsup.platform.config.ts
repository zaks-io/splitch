import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "control-plane/index": "src/control-plane/index.ts",
    "local-evaluation/index": "src/local-evaluation/index.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  bundle: true,
  splitting: false,
  clean: false,
  sourcemap: false,
  external: ["@hono/zod-openapi", "hono", /^hono\//, "zod", /^zod\//],
  tsconfig: "tsconfig.platform.json",
});
