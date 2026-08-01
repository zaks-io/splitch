#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBuildStamp } from "../../../scripts/release/build-stamp.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The bundle inlines @splitch/sdk from its built dist (the same artifact npm
// consumers get). The sdk build owns packages/sdk generated/dist artifacts;
// turbo's ^build edge guarantees it ran first, so fail loud instead of
// regenerating another package's outputs here.
for (const artifact of ["dist/index.js", "dist/index.d.ts"]) {
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
