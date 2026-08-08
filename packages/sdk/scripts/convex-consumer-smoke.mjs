#!/usr/bin/env node
/**
 * Install the packed @splitch/sdk tarball into a temp copy of
 * fixtures/convex-sdk-consumer and run convex-test / vitest.
 *
 * Transport is stubbed at the fixture seam (global fetch), not pointed at a
 * live test server — see fixtures/convex-sdk-consumer/convex/testHelpers.ts.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const fixtureRoot = join(repoRoot, "fixtures/convex-sdk-consumer");

/**
 * @param {string} tarballPath absolute path to the packed .tgz
 */
export function runConvexConsumerSmoke(tarballPath) {
  const consumerRoot = mkdtempSync(join(tmpdir(), "splitch-sdk-convex-"));
  try {
    cpSync(fixtureRoot, consumerRoot, { recursive: true });

    execFileSync(
      "npm",
      [
        "install",
        tarballPath,
        "convex@1.43.0",
        "convex-test@0.0.55",
        "vitest@4.1.10",
        "@edge-runtime/vm@5.0.0",
        "typescript@6.0.3",
      ],
      {
        cwd: consumerRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          npm_config_cache: join(consumerRoot, ".npm-cache"),
        },
      },
    );

    execFileSync("npx", ["vitest", "run"], {
      cwd: consumerRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        npm_config_cache: join(consumerRoot, ".npm-cache"),
      },
    });

    console.log("convex consumer smoke passed");
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
}
