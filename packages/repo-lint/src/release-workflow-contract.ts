import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIRST_RELEASE_VERSION = "0.1.0";

interface ReleaseContractOptions {
  targetKey: "sdk" | "cli";
  label: "SDK" | "CLI";
  packageName: "@splitch/sdk" | "@splitch/cli";
  packageDir: "packages/sdk" | "apps/cli";
  tagPrefix: "sdk-v" | "cli-v";
  workflowName: "sdk-release.yml" | "cli-release.yml";
}

export function registerReleaseWorkflowContract(options: ReleaseContractOptions): void {
  const workflow = readFileSync(
    path.join(repoRoot, `.github/workflows/${options.workflowName}`),
    "utf8",
  );

  describe(`${options.targetKey}-release workflow contract`, () => {
    it("is manual-only through workflow_dispatch", () => {
      expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
      expect(workflow).not.toMatch(/^\s+(push|release):/m);
      expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm publish/);
    });

    it("uses Blacksmith runners for all jobs", () => {
      const runners = workflow.split("\n").filter((line) => line.trim().startsWith("runs-on:"));
      expect(runners.length).toBeGreaterThanOrEqual(3);
      for (const runner of runners) expect(runner).toContain("blacksmith-");
    });

    it(`derives the ${options.label} tag without a manual version input`, () => {
      expect(workflow).toContain(`scripts/release/resolve-version.mjs ${options.targetKey}`);
      expect(workflow).not.toMatch(/inputs:\s*\n\s+version:/);
    });

    it("uses draft release preparation and never npm publish", () => {
      expect(workflow).toContain(`scripts/release/publish-draft-release.mjs ${options.targetKey}`);
      expect(workflow).toContain("does not publish to npm");
      expect(workflow).not.toContain("npm publish");
    });

    it(`builds ${options.packageName} before packaging`, () => {
      const prepareSection = workflow.split("  prepare:")[1]?.split("  draft-release:")[0] ?? "";
      const buildIndex = prepareSection.indexOf(`pnpm --filter ${options.packageName} build`);
      const packageIndex = prepareSection.indexOf(`prepare-artifacts.mjs ${options.targetKey}`);
      expect(buildIndex).toBeGreaterThan(-1);
      expect(packageIndex).toBeGreaterThan(-1);
      expect(buildIndex).toBeLessThan(packageIndex);
    });
  });

  describe(`${options.targetKey} release target resolution`, () => {
    it(`reads ${options.packageDir}/package.json and derives the tag namespace`, () => {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, options.packageDir, "package.json"), "utf8"),
      ) as { version?: string };
      expect(manifest.version).toBe(FIRST_RELEASE_VERSION);

      const output = execFileSync(
        "node",
        ["scripts/release/resolve-version.mjs", options.targetKey, repoRoot],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({
        version: FIRST_RELEASE_VERSION,
        tag: `${options.tagPrefix}${FIRST_RELEASE_VERSION}`,
        packageName: options.packageName,
      });
    });

    it("prepare-artifacts succeeds without a checked-in dist directory", () => {
      const output = execFileSync(
        "node",
        ["scripts/release/check-prepare-clean-checkout.mjs", options.targetKey, repoRoot],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(output.trim()).toBe("prepare clean-checkout check passed");
    }, 60_000);
  });
}

describe("release target argument validation", () => {
  it.each([{ args: [] }, { args: ["unknown"] }])("fails loudly for target args $args", ({
    args,
  }) => {
    expect(() =>
      execFileSync("node", ["scripts/release/resolve-version.mjs", ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow(/release target is required|unknown release target/);
  });
});
