import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowPath = path.join(repoRoot, ".github/workflows/sdk-release.yml");
const FIRST_RELEASE_VERSION = "0.1.0";
const SDK_TAG_PREFIX = "sdk-v";

describe("sdk-release workflow contract", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  it("is manual-only through workflow_dispatch", () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
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

  it("builds @splitch/sdk in the prepare job before packaging", () => {
    const prepareSection = workflow.split("  prepare:")[1]?.split("  draft-release:")[0] ?? "";
    const buildIndex = prepareSection.indexOf("pnpm --filter @splitch/sdk build");
    const packageIndex = prepareSection.indexOf("prepare-artifacts.mjs");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(packageIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeLessThan(packageIndex);
  });
});

describe("sdk release target resolution", () => {
  it("reads the checked-in SDK version and derives the sdk-v tag namespace", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/sdk/package.json"), "utf8"),
    ) as { version?: string };
    expect(manifest.version).toBe(FIRST_RELEASE_VERSION);

    const output = execFileSync("node", ["scripts/sdk-release/resolve-version.mjs", repoRoot], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const target = JSON.parse(output) as {
      version: string;
      tag: string;
      packageName: string;
    };
    expect(target).toEqual({
      version: FIRST_RELEASE_VERSION,
      tag: `${SDK_TAG_PREFIX}${FIRST_RELEASE_VERSION}`,
      packageName: "@splitch/sdk",
    });
  });

  it("prepare-artifacts succeeds from a clean checkout without packages/sdk/dist", () => {
    const output = execFileSync(
      "node",
      ["scripts/sdk-release/check-prepare-clean-checkout.mjs", repoRoot],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    expect(output.trim()).toBe("prepare clean-checkout check passed");
  }, 30_000);
});
