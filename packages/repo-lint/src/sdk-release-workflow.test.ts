import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deriveSdkTag,
  readSdkVersion,
  resolveSdkReleaseTarget,
} from "../../../scripts/sdk-release/resolve-version.mjs";
import { FIRST_RELEASE_VERSION, SDK_TAG_PREFIX } from "../../../scripts/sdk-release/constants.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowPath = path.join(repoRoot, ".github/workflows/sdk-release.yml");

describe("sdk-release workflow contract", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  it("is manual-only through workflow_dispatch", () => {
    expect(workflow).toMatch(/^on:\n  workflow_dispatch:\n/m);
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).not.toMatch(/^\s+release:/m);
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("npm publish");
  });

  it("uses Blacksmith runners for all jobs", () => {
    const runsOnLines = workflow.split("\n").filter((line) => line.trim().startsWith("runs-on:"));
    expect(runsOnLines.length).toBeGreaterThanOrEqual(3);
    for (const line of runsOnLines) {
      expect(line).toContain("blacksmith-");
    }
  });

  it("derives the SDK tag from packages/sdk/package.json without a manual version input", () => {
    expect(workflow).toContain("scripts/sdk-release/resolve-version.mjs");
    expect(workflow).not.toMatch(/inputs:\s*\n\s+version:/);
  });

  it("refuses npm publish and uses draft release preparation only", () => {
    expect(workflow).toContain("publish-draft-release.mjs");
    expect(workflow).toContain("does not publish to npm");
    expect(workflow).not.toContain("npm publish");
  });
});

describe("sdk release target resolution", () => {
  it("reads the checked-in SDK version and derives the sdk-v tag namespace", () => {
    const version = readSdkVersion(repoRoot);
    expect(version).toBe(FIRST_RELEASE_VERSION);
    expect(deriveSdkTag(version)).toBe(`${SDK_TAG_PREFIX}${version}`);
    expect(resolveSdkReleaseTarget(repoRoot)).toEqual({
      version: FIRST_RELEASE_VERSION,
      tag: `sdk-v${FIRST_RELEASE_VERSION}`,
      packageName: "@splitch/sdk",
    });
  });
});
