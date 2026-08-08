import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
interface BuildStamp {
  packageName: string;
  version: string;
  sourceDigest: string;
}
const { computeTreeDigest, computeSourceDigest, verifyBuildStamp, writeBuildStamp } = (await import(
  pathToFileURL(path.join(repoRoot, "scripts/release/build-stamp.mjs")).href
)) as {
  computeTreeDigest: (dir: string) => string;
  computeSourceDigest: (targetKey: string, repoRoot: string) => string;
  verifyBuildStamp: (targetKey: string, repoRoot: string) => BuildStamp;
  writeBuildStamp: (targetKey: string, repoRoot: string) => BuildStamp;
};
const { RELEASE_TARGETS } = (await import(
  pathToFileURL(path.join(repoRoot, "scripts/release/constants.mjs")).href
)) as {
  RELEASE_TARGETS: {
    sdk: { stampInputs: readonly string[] };
  };
};

let scratch: string;
let packageRoot: string;

function manifest(version = "0.2.0"): string {
  return `${JSON.stringify({ name: "@splitch/sdk", version })}\n`;
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "splitch-build-stamp-"));
  packageRoot = path.join(scratch, "packages/sdk");
  mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), manifest());
  writeFileSync(path.join(packageRoot, "src/index.ts"), "export const a = 1;\n");
  writeFileSync(path.join(packageRoot, "dist/index.js"), "export const a = 1;\n");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("build stamp guard", () => {
  it("accepts a freshly stamped build", () => {
    writeBuildStamp("sdk", scratch);
    expect(verifyBuildStamp("sdk", scratch).packageName).toBe("@splitch/sdk");
  });

  it("fails loud when dist has no stamp", () => {
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/build-stamp\.json is missing/);
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/Remediation/);
  });

  it("fails loud when sources changed after the stamp", () => {
    writeBuildStamp("sdk", scratch);
    writeFileSync(path.join(packageRoot, "src/index.ts"), "export const a = 2;\n");
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/dist is stale/);
  });

  it("fails loud when the version was bumped after the stamp", () => {
    writeBuildStamp("sdk", scratch);
    writeFileSync(path.join(packageRoot, "package.json"), manifest("0.3.0"));
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/manifest is @splitch\/sdk@0\.3\.0/);
  });

  it("fails loud when dist bytes were modified after the stamp", () => {
    writeBuildStamp("sdk", scratch);
    writeFileSync(path.join(packageRoot, "dist/index.js"), "export const a = 999;\n");
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/dist was modified after the build/);
  });

  it("fails loud when the stamp itself was tampered with", () => {
    writeBuildStamp("sdk", scratch);
    const stampFile = path.join(packageRoot, "dist/build-stamp.json");
    const stamp = JSON.parse(readFileSync(stampFile, "utf8")) as { sourceDigest: string };
    stamp.sourceDigest = "0".repeat(64);
    writeFileSync(stampFile, JSON.stringify(stamp));
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/dist is stale/);
  });

  it("stamps are deterministic and exclude the stamp file itself", () => {
    const first = writeBuildStamp("sdk", scratch);
    const second = writeBuildStamp("sdk", scratch);
    expect(second.sourceDigest).toBe(first.sourceDigest);
  });

  it("tree digests detect any dist mutation", () => {
    const before = computeTreeDigest(path.join(packageRoot, "dist"));
    writeFileSync(path.join(packageRoot, "dist/index.js"), "export const a = 3;\n");
    expect(computeTreeDigest(path.join(packageRoot, "dist"))).not.toBe(before);
  });

  it("sdk stampInputs cover browser tsup and exposure surface sources (SPL-332)", () => {
    expect(RELEASE_TARGETS.sdk.stampInputs).toEqual(
      expect.arrayContaining(["scripts/contract-surface-exposures.ts", "tsup.browser.config.ts"]),
    );
  });

  it("sdk source digest changes when exposure surface or browser tsup inputs change", () => {
    const exposures = path.join(repoRoot, "packages/sdk/scripts/contract-surface-exposures.ts");
    const browserTsup = path.join(repoRoot, "packages/sdk/tsup.browser.config.ts");
    const baseline = computeSourceDigest("sdk", repoRoot);
    const marker = `\n// t332r9-stamp-probe ${Date.now()}\n`;
    const exposuresBefore = readFileSync(exposures, "utf8");
    const browserBefore = readFileSync(browserTsup, "utf8");

    try {
      writeFileSync(exposures, `${exposuresBefore}${marker}`);
      expect(computeSourceDigest("sdk", repoRoot)).not.toBe(baseline);
      writeFileSync(exposures, exposuresBefore);
      expect(computeSourceDigest("sdk", repoRoot)).toBe(baseline);

      writeFileSync(browserTsup, `${browserBefore}${marker}`);
      expect(computeSourceDigest("sdk", repoRoot)).not.toBe(baseline);
    } finally {
      writeFileSync(exposures, exposuresBefore);
      writeFileSync(browserTsup, browserBefore);
    }
    expect(computeSourceDigest("sdk", repoRoot)).toBe(baseline);
  });
});
