import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/bin.ts",
    index: "src/index.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "es2022",
  platform: "node",
  dts: true,
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: false,
  noExternal: [/^@splitch\//],
  external: ["@hono/zod-openapi", "@sentry/node", "hono", "zod"],
});
