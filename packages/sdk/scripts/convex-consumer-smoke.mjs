#!/usr/bin/env node
/**
 * Install the packed @splitch/sdk tarball into a temp copy of
 * fixtures/convex-sdk-consumer and run convex-test / vitest.
 *
 * Transport is stubbed at the fixture seam (global fetch), not pointed at a
 * live test server — see fixtures/convex-sdk-consumer/convex/testHelpers.ts.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const fixtureRoot = join(repoRoot, "fixtures/convex-sdk-consumer");

function extractConvexBoundarySnippet() {
  const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
  const heading = "### Flags in queries and mutations";
  const sectionStart = readme.indexOf(heading);
  if (sectionStart === -1) {
    throw new Error(`SDK README is missing ${heading}`);
  }
  const match = readme.slice(sectionStart).match(/```ts\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error(`${heading} is missing its TypeScript example`);
  }
  return `${match[1]}\n`;
}

/**
 * @param {string} tarballPath absolute path to the packed .tgz
 */
export function runConvexConsumerSmoke(tarballPath) {
  const consumerRoot = mkdtempSync(join(tmpdir(), "splitch-sdk-convex-"));
  try {
    cpSync(fixtureRoot, consumerRoot, { recursive: true });
    const documentedSnippet = extractConvexBoundarySnippet();
    const fixtureSnippetPath = join(fixtureRoot, "convex/checkout.ts");
    if (readFileSync(fixtureSnippetPath, "utf8") !== documentedSnippet) {
      throw new Error("Convex boundary fixture has drifted from the SDK README example");
    }
    writeFileSync(join(consumerRoot, "convex/checkout.ts"), documentedSnippet);

    execFileSync(
      "npm",
      [
        "install",
        tarballPath,
        "convex@1.43.0",
        "convex-test@0.0.55",
        "vitest@4.1.10",
        "@edge-runtime/vm@5.0.0",
        "@types/node@26.1.1",
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

    execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--noEmit"], {
      cwd: consumerRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        npm_config_cache: join(consumerRoot, ".npm-cache"),
      },
    });

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
