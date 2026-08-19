import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTaskHashFromDryRun,
  computeSourceDigest,
  computeTreeDigest,
  verifyBuildStamp,
  writeBuildStamp,
} from "../../../scripts/release/build-stamp.mjs";
import { RELEASE_TARGETS } from "../../../scripts/release/constants.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sdkPackageRoot = path.join(repoRoot, "packages/sdk");
const FIXTURE_DIGEST = "fixture-digest";

/** Same CI/NODE_ENV strip the stamp writer uses so hashes match under vitest. */
function readTurboBuildDryRun(packageName: string) {
  const env = { ...process.env };
  delete env.CI;
  delete env.NODE_ENV;
  const out = execFileSync(
    path.join(repoRoot, "node_modules", ".bin", "turbo"),
    ["run", "build", `--filter=${packageName}`, "--dry=json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(out.slice(out.indexOf("{"))) as {
    globalCacheInputs: { files: Record<string, string> };
    tasks: Array<{
      package: string;
      task: string;
      hash: string;
      inputs: Record<string, string>;
    }>;
  };
}

function turboBuildTask(packageName: string) {
  const dry = readTurboBuildDryRun(packageName);
  const task = dry.tasks.find((entry) => entry.package === packageName && entry.task === "build");
  if (task === undefined) {
    throw new Error(`missing turbo build task for ${packageName}`);
  }
  return { dry, task };
}

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

describe("build stamp guard (fixture digests)", () => {
  it("accepts a freshly stamped build", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST });
    expect(verifyBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST }).packageName).toBe(
      "@splitch/sdk",
    );
  });

  it("fails loud when dist has no stamp", () => {
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/build-stamp\.json is missing/);
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/Remediation/);
  });

  it("fails loud when sources changed after the stamp", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: "before" });
    writeFileSync(path.join(packageRoot, "src/index.ts"), "export const a = 2;\n");
    expect(() => verifyBuildStamp("sdk", scratch, { sourceDigest: "after" })).toThrow(
      /dist is stale/,
    );
  });

  it("fails loud when the version was bumped after the stamp", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST });
    writeFileSync(path.join(packageRoot, "package.json"), manifest("0.3.0"));
    expect(() => verifyBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST })).toThrow(
      /manifest is @splitch\/sdk@0\.3\.0/,
    );
  });

  it("fails loud when dist bytes were modified after the stamp", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST });
    writeFileSync(path.join(packageRoot, "dist/index.js"), "export const a = 999;\n");
    expect(() => verifyBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST })).toThrow(
      /dist was modified after the build/,
    );
  });

  it("fails loud when the stamp itself was tampered with", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST });
    const stampFile = path.join(packageRoot, "dist/build-stamp.json");
    const stamp = JSON.parse(readFileSync(stampFile, "utf8")) as { sourceDigest: string };
    stamp.sourceDigest = "0".repeat(16);
    writeFileSync(stampFile, JSON.stringify(stamp));
    expect(() => verifyBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST })).toThrow(
      /dist is stale/,
    );
  });

  it("fails loud when sourceDigest is missing from a degraded stamp", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST });
    const stampFile = path.join(packageRoot, "dist/build-stamp.json");
    const stamp = JSON.parse(readFileSync(stampFile, "utf8")) as Record<string, unknown>;
    delete stamp.sourceDigest;
    writeFileSync(stampFile, `${JSON.stringify(stamp, null, 2)}\n`);
    expect(() => verifyBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST })).toThrow(
      /degraded: sourceDigest/,
    );
  });

  it("stamps are deterministic and exclude the stamp file itself", () => {
    const first = writeBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST });
    const second = writeBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST });
    expect(second.sourceDigest).toBe(first.sourceDigest);
    expect(second.distDigest).toBe(first.distDigest);
  });

  it("tree digests detect any dist mutation", () => {
    const before = computeTreeDigest(path.join(packageRoot, "dist"));
    writeFileSync(path.join(packageRoot, "dist/index.js"), "export const a = 3;\n");
    expect(computeTreeDigest(path.join(packageRoot, "dist"))).not.toBe(before);
  });

  it("does not honor SPLITCH_BUILD_STAMP_SOURCE_DIGEST as a freshness hatch", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: FIXTURE_DIGEST });
    process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST = FIXTURE_DIGEST;
    try {
      // Scratch has no turbo.json: computeSourceDigest must throw rather than
      // silently fall back or honor the env var.
      expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/turbo\.json missing/);
    } finally {
      delete process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST;
    }
  });

  it("computeSourceDigest fails loud when turbo.json is absent", () => {
    expect(() => computeSourceDigest("sdk", scratch)).toThrow(/turbo\.json missing/);
  });
});

describe("build stamp guard (turbo-derived)", () => {
  it("release targets do not carry a hand-maintained stampInputs mirror", () => {
    for (const [key, target] of Object.entries(RELEASE_TARGETS)) {
      expect(target, key).not.toHaveProperty("stampInputs");
    }
  });

  it("sdk build dry-run inputs all resolve on disk and fold global tsconfig.base", () => {
    const { dry, task } = turboBuildTask("@splitch/sdk");
    expect(Object.keys(dry.globalCacheInputs.files)).toEqual(
      expect.arrayContaining(["biome.json", "tsconfig.base.json"]),
    );
    const inputPaths = Object.keys(task.inputs);
    expect(inputPaths.length).toBeGreaterThan(0);
    // No hand-maintained filename list: every Turbo-reported input must exist
    // under the package root (paths are package-relative).
    for (const inputPath of inputPaths) {
      expect(existsSync(path.join(sdkPackageRoot, inputPath)), inputPath).toBe(true);
    }
  });

  it("cli build dry-run folds global tsconfig.base.json", () => {
    const { dry, task } = turboBuildTask("@splitch/cli");
    expect(Object.keys(dry.globalCacheInputs.files)).toEqual(
      expect.arrayContaining(["tsconfig.base.json"]),
    );
    expect(task.hash).toEqual(expect.any(String));
  });

  it("source digest equals the turbo build task hash", () => {
    const { task } = turboBuildTask("@splitch/sdk");
    expect(computeSourceDigest("sdk", repoRoot)).toBe(task.hash);
  });

  it("verifyBuildStamp fails when the stamped digest drifts from current sources", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: "stale-turbo-hash" });
    expect(() => verifyBuildStamp("sdk", scratch, { sourceDigest: "current-turbo-hash" })).toThrow(
      /dist is stale/,
    );
  });

  it("fails loud when turbo dry-run omits the build task hash", () => {
    // Shape guard: renaming the hash key (or dropping it) must throw — without
    // this, writeBuildStamp would emit a stamp with sourceDigest dropped by
    // JSON.stringify(undefined) and verifyBuildStamp would compare
    // undefined !== undefined → green forever.
    expect(() =>
      buildTaskHashFromDryRun(
        {
          tasks: [{ package: "@splitch/sdk", task: "build", hashKey: "not-hash" }],
        },
        "@splitch/sdk",
      ),
    ).toThrow(/turbo dry-run missing build task hash for @splitch\/sdk/);
    expect(() =>
      buildTaskHashFromDryRun(
        {
          tasks: [{ package: "@splitch/sdk", task: "build", hash: "" }],
        },
        "@splitch/sdk",
      ),
    ).toThrow(/turbo dry-run missing build task hash for @splitch\/sdk/);
    expect(() => buildTaskHashFromDryRun({ tasks: [] }, "@splitch/sdk")).toThrow(
      /turbo dry-run missing build task hash for @splitch\/sdk/,
    );
  });
});
