#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * npm publish runs a manifest fixer that npm pack does not; it can silently
 * drop fields it dislikes. Fail loud if the publish path would ship anything
 * other than the checked manifest.
 *
 * The probe runs against a copy stamped with an unpublishable prerelease
 * version, because `npm publish --dry-run` also refuses a version already on
 * the registry and that refusal answers a different question. Without this the
 * check would pass only until the package's current version shipped, then fail
 * forever on a manifest it never actually inspected. The real version-collision
 * guard is the release workflow's own publish step
 * (scripts/release/validate-live-publish-state.mjs).
 */
export function assertPublishKeepsManifest(stagingDir) {
  const probe = mkdtempSync(join(tmpdir(), "splitch-publish-probe-"));
  try {
    cpSync(stagingDir, probe, { recursive: true });
    const manifestPath = join(probe, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, version: `${manifest.version}-publishprobe.0` }, null, 2)}\n`,
    );
    // `--tag` is mandatory for a prerelease version and never reaches the
    // registry under `--dry-run`; it exists only to satisfy that rule.
    const args = ["publish", "--dry-run", "--tag", "publishprobe"];
    const { stdout, stderr, status, error } = spawnSync("npm", args, {
      cwd: probe,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(probe, ".npm-cache") },
    });
    if (error) throw error;
    if (status !== 0) {
      throw new Error(stderr || stdout || `npm publish --dry-run failed with exit code ${status}`);
    }
    const output = `${stdout}\n${stderr}`;
    if (/auto-corrected|errors corrected|was invalid/i.test(output)) {
      throw new Error(`npm publish would rewrite the release manifest:\n${output}`);
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
