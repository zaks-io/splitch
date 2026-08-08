import { execFileSync } from "node:child_process";
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
  distDigest: string;
}
const { computeTreeDigest, computeSourceDigest, verifyBuildStamp, writeBuildStamp } = (await import(
  pathToFileURL(path.join(repoRoot, "scripts/release/build-stamp.mjs")).href
)) as {
  computeTreeDigest: (dir: string) => string;
  computeSourceDigest: (targetKey: string, repoRoot: string) => string;
  verifyBuildStamp: (targetKey: string, repoRoot: string) => BuildStamp;
  writeBuildStamp: (
    targetKey: string,
    repoRoot: string,
    options?: { sourceDigest?: string },
  ) => BuildStamp;
};
const { RELEASE_TARGETS } = (await import(
  pathToFileURL(path.join(repoRoot, "scripts/release/constants.mjs")).href
)) as {
  RELEASE_TARGETS: Record<string, Record<string, unknown>>;
};

/** Same CI/NODE_ENV strip the stamp writer uses so hashes match under vitest. */
function readTurboBuildDryRun(packageName: string) {
  const env = { ...process.env };
  delete env.CI;
  delete env.NODE_ENV;
  const out = execFileSync(
    path.join(repoRoot, "node_modules", ".bin", "turbo"),
    ["run", "build", `--filter=${packageName}`, "--dry=json"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env },
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
  delete process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST;
});

describe("build stamp guard (fixture digests)", () => {
  it("accepts a freshly stamped build", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: "fixture-digest" });
    process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST = "fixture-digest";
    expect(verifyBuildStamp("sdk", scratch).packageName).toBe("@splitch/sdk");
  });

  it("fails loud when dist has no stamp", () => {
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/build-stamp\.json is missing/);
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/Remediation/);
  });

  it("fails loud when sources changed after the stamp", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: "before" });
    process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST = "after";
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/dist is stale/);
  });

  it("fails loud when the version was bumped after the stamp", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: "fixture-digest" });
    writeFileSync(path.join(packageRoot, "package.json"), manifest("0.3.0"));
    process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST = "fixture-digest";
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/manifest is @splitch\/sdk@0\.3\.0/);
  });

  it("fails loud when dist bytes were modified after the stamp", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: "fixture-digest" });
    writeFileSync(path.join(packageRoot, "dist/index.js"), "export const a = 999;\n");
    process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST = "fixture-digest";
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/dist was modified after the build/);
  });

  it("fails loud when the stamp itself was tampered with", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: "fixture-digest" });
    const stampFile = path.join(packageRoot, "dist/build-stamp.json");
    const stamp = JSON.parse(readFileSync(stampFile, "utf8")) as { sourceDigest: string };
    stamp.sourceDigest = "0".repeat(16);
    writeFileSync(stampFile, JSON.stringify(stamp));
    process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST = "fixture-digest";
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/dist is stale/);
  });

  it("stamps are deterministic and exclude the stamp file itself", () => {
    const first = writeBuildStamp("sdk", scratch, { sourceDigest: "fixture-digest" });
    const second = writeBuildStamp("sdk", scratch, { sourceDigest: "fixture-digest" });
    expect(second.sourceDigest).toBe(first.sourceDigest);
    expect(second.distDigest).toBe(first.distDigest);
  });

  it("tree digests detect any dist mutation", () => {
    const before = computeTreeDigest(path.join(packageRoot, "dist"));
    writeFileSync(path.join(packageRoot, "dist/index.js"), "export const a = 3;\n");
    expect(computeTreeDigest(path.join(packageRoot, "dist"))).not.toBe(before);
  });
});

describe("build stamp guard (turbo-derived)", () => {
  it("release targets do not carry a hand-maintained stampInputs mirror", () => {
    for (const [key, target] of Object.entries(RELEASE_TARGETS)) {
      expect(target, key).not.toHaveProperty("stampInputs");
    }
  });

  it("sdk build dry-run includes global tsconfig.base and size-check.mjs", () => {
    const { dry, task } = turboBuildTask("@splitch/sdk");
    expect(Object.keys(dry.globalCacheInputs.files)).toEqual(
      expect.arrayContaining(["biome.json", "tsconfig.base.json"]),
    );
    expect(Object.keys(task.inputs)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/size-check\.mjs$/),
        expect.stringMatching(/tsup\.browser\.config\.ts$/),
        expect.stringMatching(/contract-surface-exposures\.ts$/),
        expect.stringMatching(/generate-contract-surface\.mjs$/),
      ]),
    );
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

  it("verifyBuildStamp fails when the turbo hash drifts from the stamp", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: "stale-turbo-hash" });
    process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST = "current-turbo-hash";
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/dist is stale/);
  });

  it("live sdk dist stamp matches the current turbo build hash", () => {
    // Fails when a real turbo build input is added (or edited) and dist is
    // left unstamped — the same signal pack/publish use. Proven red by
    // introducing packages/sdk/scripts/t332r11-new-input.mjs into the
    // generate import graph before rebuilding.
    expect(() => verifyBuildStamp("sdk", repoRoot)).not.toThrow();
  });
});
