import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RELEASE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const releaseConstants = readFileSync(path.join(repoRoot, "scripts/release/constants.mjs"), "utf8");
const publishDraftRelease = readFileSync(
  path.join(repoRoot, "scripts/release/publish-draft-release.mjs"),
  "utf8",
);

interface ReleaseContractOptions {
  targetKey: "sdk" | "cli" | "convex" | "cloudflare";
  label: "SDK" | "CLI" | "CONVEX" | "CLOUDFLARE";
  packageName: "@splitch/sdk" | "@splitch/cli" | "@splitch/convex" | "@splitch/cloudflare";
  packageDir: "packages/sdk" | "apps/cli" | "packages/convex" | "packages/cloudflare";
  tagPrefix: "sdk-v" | "cli-v" | "convex-v" | "cloudflare-v";
  workflowName:
    | "sdk-release.yml"
    | "cli-release.yml"
    | "convex-release.yml"
    | "cloudflare-release.yml";
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

    it(`builds ${options.packageName} through turbo before packaging`, () => {
      const prepareSection = workflow.split("  prepare:")[1]?.split("  draft-release:")[0] ?? "";
      const buildIndex = prepareSection.indexOf(
        `pnpm exec turbo run build --filter=${options.packageName}`,
      );
      const packageIndex = prepareSection.indexOf(`prepare-artifacts.mjs ${options.targetKey}`);
      expect(buildIndex).toBeGreaterThan(-1);
      expect(packageIndex).toBeGreaterThan(-1);
      expect(buildIndex).toBeLessThan(packageIndex);
      // A bare `pnpm --filter <pkg> build` bypasses turbo and forfeits the
      // remote cache entry the validate job just wrote at the same SHA.
      expect(prepareSection).not.toContain(`pnpm --filter ${options.packageName} build`);
    });
  });

  describe(`${options.targetKey} release target resolution`, () => {
    it(`reads ${options.packageDir}/package.json and derives the tag namespace`, () => {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, options.packageDir, "package.json"), "utf8"),
      ) as { version?: string };
      expect(manifest.version).toMatch(RELEASE_SEMVER_PATTERN);

      const output = execFileSync(
        "node",
        ["scripts/release/resolve-version.mjs", options.targetKey, repoRoot],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({
        version: manifest.version,
        tag: `${options.tagPrefix}${manifest.version}`,
        packageName: options.packageName,
      });
    });

    it("green-skips an already-released version instead of failing", () => {
      expect(workflow).toContain(
        `scripts/release/check-release-published.mjs ${options.targetKey}`,
      );
      const skipConditions = workflow
        .split("\n")
        .filter((line) => line.includes("needs.validate.outputs.already_released != 'true'"));
      // prepare and draft-release must both stand down on the no-op path.
      expect(skipConditions.length).toBe(2);
      expect(workflow).toContain("already has a published release");
    });

    it("prepare-artifacts stages a stamped dist and refuses an unstamped checkout", () => {
      const output = execFileSync(
        "node",
        ["scripts/release/check-prepare-artifacts-contract.mjs", options.targetKey, repoRoot],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(output.trim()).toBe("prepare-artifacts contract check passed");
    }, 60_000);
  });
}

describe("already-released detection", () => {
  const load = async () =>
    (await import(
      pathToFileURL(path.join(repoRoot, "scripts/release/check-release-published.mjs")).href
    )) as { isReleasePublished: (options: Record<string, unknown>) => Promise<boolean> };
  const base = { tag: "cli-v9.9.9", repository: "zaks-io/splitch", token: "t" };
  const respond = (status: number, body?: unknown) =>
    (async () => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    })) as unknown as typeof fetch;

  it("is false when the tag has no release", async () => {
    const { isReleasePublished } = await load();
    await expect(isReleasePublished({ ...base, fetchImpl: respond(404) })).resolves.toBe(false);
  });

  it("is false while the release is still a draft", async () => {
    const { isReleasePublished } = await load();
    await expect(
      isReleasePublished({ ...base, fetchImpl: respond(200, { draft: true }) }),
    ).resolves.toBe(false);
  });

  it("is true for a published release", async () => {
    const { isReleasePublished } = await load();
    await expect(
      isReleasePublished({ ...base, fetchImpl: respond(200, { draft: false }) }),
    ).resolves.toBe(true);
  });

  it("fails loudly on unexpected lookup errors", async () => {
    const { isReleasePublished } = await load();
    await expect(isReleasePublished({ ...base, fetchImpl: respond(500) })).rejects.toThrow(
      /HTTP 500/,
    );
  });
});

describe("GitHub latest release policy", () => {
  it("reserves the repository-wide Latest release for the CLI stream", () => {
    expect(releaseConstants).toMatch(
      /sdk: Object\.freeze\(\{[\s\S]*?githubLatest: false,[\s\S]*?\}\),\n {2}cli:/,
    );
    expect(releaseConstants).toMatch(/cli: Object\.freeze\(\{[\s\S]*?githubLatest: "automatic",/);
    expect(publishDraftRelease).toContain(
      'target.githubLatest === false ? ["--latest=false"] : []',
    );
    expect(publishDraftRelease).toMatch(
      /"release",\n {4}"create",[\s\S]*?"--target",\n {4}commitSha,\n {4}\.\.\.latestArgs,/,
    );
  });
});

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
