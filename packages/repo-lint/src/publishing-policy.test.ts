import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWED_PUBLISHABLE_PACKAGES } from "./policy/constants.mjs";
import { lintPublishingPolicy, lintPublishingPolicyFromRepo } from "./policy/run.mjs";
import {
  lintWorkspaceDependencyPolicy,
  lintWorkspacePublishability,
} from "./policy/publishability.mjs";
import { lintReleaseMetadata } from "./policy/release-metadata.mjs";

type PackageManifest = Record<string, unknown> & {
  name?: string;
  private?: boolean;
};

type WorkspacePackage = {
  packagePath: string;
  manifest: PackageManifest;
};

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

function loadFixture(name: string): PackageManifest {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as PackageManifest;
}

function pkg(packagePath: string, manifest: PackageManifest): WorkspacePackage {
  return { packagePath, manifest };
}

const validSdkManifest = loadFixture("sdk-valid.package.json");
const validCliManifest = loadFixture("cli-valid.package.json");

describe("lintWorkspacePublishability", () => {
  it("passes when only @splitch/sdk and @splitch/cli are publishable", () => {
    const violations = lintWorkspacePublishability([
      pkg("packages/sdk/package.json", { ...validSdkManifest, private: undefined }),
      pkg("apps/cli/package.json", { ...validCliManifest, private: undefined }),
      pkg("packages/contracts/package.json", {
        name: "@splitch/contracts",
        private: true,
      }),
      pkg("packages/ui/package.json", { name: "@splitch/ui", private: true }),
    ]);
    expect(violations).toEqual([]);
  });

  it("fails when a non-sdk workspace is publishable", () => {
    const violations = lintWorkspacePublishability([
      pkg("packages/ui/package.json", { name: "@splitch/ui" }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("only @splitch/sdk, @splitch/cli may be published");
  });

  it("fails when @splitch/contracts is publishable", () => {
    const violations = lintWorkspacePublishability([
      pkg("packages/contracts/package.json", { name: "@splitch/contracts" }),
    ]);
    expect(violations.some((violation) => violation.message.includes("must remain private"))).toBe(
      true,
    );
  });

  it("fails when @splitch/sdk is marked private", () => {
    const violations = lintWorkspacePublishability([
      pkg("packages/sdk/package.json", {
        ...validSdkManifest,
        private: true,
      }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("must remain publishable");
  });

  it("fails when @splitch/cli is marked private", () => {
    const violations = lintWorkspacePublishability([
      pkg("apps/cli/package.json", {
        ...validCliManifest,
        private: true,
      }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("must remain publishable");
  });
});

describe("lintWorkspaceDependencyPolicy", () => {
  it("requires workspace:* for @splitch dependencies", () => {
    const violations = lintWorkspaceDependencyPolicy([
      pkg("apps/cli/package.json", {
        name: "@splitch/cli",
        dependencies: {
          "@splitch/contracts": "^0.0.0",
        },
      }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("must use workspace:*");
  });
});

describe("lintReleaseMetadata", () => {
  it("accepts the valid SDK fixture", () => {
    expect(lintReleaseMetadata(pkg("packages/sdk/package.json", validSdkManifest))).toEqual([]);
  });

  it("fails when SDK depends on a private workspace package", () => {
    const violations = lintReleaseMetadata(
      pkg("packages/sdk/package.json", loadFixture("sdk-leaks-workspace-dependency.package.json")),
    );
    expect(violations.some((violation) => violation.message.includes("private workspace"))).toBe(
      true,
    );
  });

  it("fails when SDK exports reference source files", () => {
    const violations = lintReleaseMetadata(
      pkg("packages/sdk/package.json", loadFixture("sdk-exports-src.package.json")),
    );
    expect(violations.some((violation) => violation.message.includes("source paths"))).toBe(true);
  });

  it("fails when publishConfig.access is not public", () => {
    const violations = lintReleaseMetadata(
      pkg("packages/sdk/package.json", loadFixture("sdk-restricted-access.package.json")),
    );
    expect(violations.some((violation) => violation.message.includes("publishConfig.access"))).toBe(
      true,
    );
  });

  it("fails when license metadata is missing", () => {
    const violations = lintReleaseMetadata(
      pkg("packages/sdk/package.json", loadFixture("sdk-missing-license.package.json")),
    );
    expect(violations.some((violation) => violation.message.includes("SPDX license"))).toBe(true);
  });

  it("fails when files include raw source", () => {
    const violations = lintReleaseMetadata(
      pkg("packages/sdk/package.json", loadFixture("sdk-ships-src.package.json")),
    );
    expect(violations.some((violation) => violation.message.includes("raw source"))).toBe(true);
  });

  it("accepts CLI workspace devDependencies because packing strips them", () => {
    expect(lintReleaseMetadata(pkg("apps/cli/package.json", validCliManifest))).toEqual([]);
  });

  it("fails when CLI leaks a workspace dependency at runtime", () => {
    const violations = lintReleaseMetadata(
      pkg("apps/cli/package.json", loadFixture("cli-leaks-runtime-workspace-dep.package.json")),
    );
    expect(violations.some((violation) => violation.message.includes("private workspace"))).toBe(
      true,
    );
  });

  it("fails when CLI ships source files", () => {
    const violations = lintReleaseMetadata(
      pkg("apps/cli/package.json", loadFixture("cli-ships-src.package.json")),
    );
    expect(violations.some((violation) => violation.message.includes("raw source"))).toBe(true);
  });

  it("fails when CLI omits its executable bin", () => {
    const violations = lintReleaseMetadata(
      pkg("apps/cli/package.json", loadFixture("cli-missing-bin.package.json")),
    );
    expect(violations.some((violation) => violation.message.includes("bin must be exactly"))).toBe(
      true,
    );
  });

  it("fails when CLI exports source files", () => {
    const violations = lintReleaseMetadata(
      pkg("apps/cli/package.json", loadFixture("cli-exports-src.package.json")),
    );
    expect(violations.some((violation) => violation.message.includes("source paths"))).toBe(true);
  });
});

describe("lintPublishingPolicy", () => {
  it("aggregates violations across policy groups", () => {
    const violations = lintPublishingPolicy([
      pkg("packages/contracts/package.json", { name: "@splitch/contracts" }),
      pkg("packages/sdk/package.json", loadFixture("sdk-leaks-workspace-dependency.package.json")),
    ]);
    expect(violations.length).toBeGreaterThan(1);
  });
});

describe("repo publishing policy against the live monorepo", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  it("passes for the checked-in workspace manifests once SDK metadata is release-ready", async () => {
    const violations = await lintPublishingPolicyFromRepo(repoRoot);
    expect(violations).toEqual([]);
  });

  it("only allows the declared public package set to be publishable", async () => {
    const violations = await lintPublishingPolicyFromRepo(repoRoot);
    const unexpectedPublishable = violations.filter((violation) =>
      violation.message.includes("may be published"),
    );
    expect(unexpectedPublishable).toEqual([]);
    expect(ALLOWED_PUBLISHABLE_PACKAGES).toEqual(new Set(["@splitch/sdk", "@splitch/cli"]));
  });
});
