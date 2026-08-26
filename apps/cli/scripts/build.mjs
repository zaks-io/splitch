#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBuildStamp } from "../../../scripts/release/build-stamp.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The published CLI imports @splitch/sdk at runtime. Its declaration build still
// resolves the same SDK artifacts npm consumers get, so fail loud when a caller
// builds only this package instead of its dependency closure.
for (const artifact of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/control-plane/index.js",
  "dist/control-plane/index.d.ts",
]) {
  const sdkArtifact = resolve(packageRoot, "../../packages/sdk", artifact);
  if (!existsSync(sdkArtifact)) {
    throw new Error(
      `@splitch/sdk ${artifact} is missing; run "pnpm --filter @splitch/sdk build" first`,
    );
  }
}

execFileSync("npx", ["tsup", "--config", "tsup.config.ts"], {
  cwd: packageRoot,
  stdio: "inherit",
});

writeBuildStamp("cli", resolve(packageRoot, "../.."));
