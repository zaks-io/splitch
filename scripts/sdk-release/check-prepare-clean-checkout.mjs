#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.argv[2] ?? process.cwd();
const sdkDist = join(repoRoot, "packages/sdk/dist");

if (existsSync(sdkDist)) {
  rmSync(sdkDist, { recursive: true, force: true });
}

const outputDir = mkdtempSync(join(tmpdir(), "splitch-sdk-release-clean-checkout-"));

try {
  const output = execFileSync(
    "node",
    ["scripts/sdk-release/prepare-artifacts.mjs", repoRoot, outputDir, "clean-checkout-test"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const manifestLine = output.trim().split("\n").at(-1);
  if (!manifestLine) {
    throw new Error("prepare-artifacts did not emit a release manifest");
  }

  const manifest = JSON.parse(manifestLine);
  if (typeof manifest.tarballName !== "string" || !manifest.tarballName.endsWith(".tgz")) {
    throw new Error(`prepare-artifacts did not produce a tarball: ${manifestLine}`);
  }

  const tarballPath = join(outputDir, manifest.tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`missing tarball at ${tarballPath}`);
  }

  process.stdout.write("prepare clean-checkout check passed\n");
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
