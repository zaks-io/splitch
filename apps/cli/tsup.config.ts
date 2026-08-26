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
  noExternal: [/^@splitch\/(?!sdk(?:\/|$))/],
  external: ["@splitch/sdk", /^@splitch\/sdk\//, "@sentry/node", "open"],
});
