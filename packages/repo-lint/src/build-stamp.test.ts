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
const {
  computeTreeDigest,
  computeSourceDigest,
  verifyBuildStamp,
  writeBuildStamp,
  buildTaskHashFromDryRun,
} = (await import(pathToFileURL(path.join(repoRoot, "scripts/release/build-stamp.mjs")).href)) as {
  computeTreeDigest: (dir: string) => string;
  computeSourceDigest: (targetKey: string, repoRoot: string) => string;
  verifyBuildStamp: (targetKey: string, repoRoot: string) => BuildStamp;
  writeBuildStamp: (
    targetKey: string,
    repoRoot: string,
    options?: { sourceDigest?: string },
  ) => BuildStamp;
  buildTaskHashFromDryRun: (dry: unknown, packageName: string) => string;
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
    stamp.sourceDigest = "0".repeat(16);
    writeFileSync(stampFile, JSON.stringify(stamp));
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/dist is stale/);
  });

  it("fails loud when sourceDigest is missing from a degraded stamp", () => {
    writeBuildStamp("sdk", scratch);
    const stampFile = path.join(packageRoot, "dist/build-stamp.json");
    const stamp = JSON.parse(readFileSync(stampFile, "utf8")) as Record<string, unknown>;
    delete stamp.sourceDigest;
    writeFileSync(stampFile, `${JSON.stringify(stamp, null, 2)}\n`);
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/degraded: sourceDigest/);
  });

  it("stamps are deterministic and exclude the stamp file itself", () => {
    const first = writeBuildStamp("sdk", scratch);
    const second = writeBuildStamp("sdk", scratch);
    expect(second.sourceDigest).toBe(first.sourceDigest);
    expect(second.distDigest).toBe(first.distDigest);
  });

  it("tree digests detect any dist mutation", () => {
    const before = computeTreeDigest(path.join(packageRoot, "dist"));
    writeFileSync(path.join(packageRoot, "dist/index.js"), "export const a = 3;\n");
    expect(computeTreeDigest(path.join(packageRoot, "dist"))).not.toBe(before);
  });

  it("does not honor SPLITCH_BUILD_STAMP_SOURCE_DIGEST as a freshness hatch", () => {
    writeBuildStamp("sdk", scratch);
    const stampFile = path.join(packageRoot, "dist/build-stamp.json");
    const stamped = (JSON.parse(readFileSync(stampFile, "utf8")) as { sourceDigest: string })
      .sourceDigest;
    writeFileSync(path.join(packageRoot, "src/index.ts"), "export const a = 2;\n");
    // If the env hatch still existed, setting it to the *stamped* digest would
    // make pack/publish accept a tree that no longer matches the stamp.
    process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST = stamped;
    try {
      expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/dist is stale/);
    } finally {
      delete process.env.SPLITCH_BUILD_STAMP_SOURCE_DIGEST;
    }
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

  it("verifyBuildStamp fails when the stamped digest drifts from current sources", () => {
    writeBuildStamp("sdk", scratch, { sourceDigest: "stale-turbo-hash" });
    expect(() => verifyBuildStamp("sdk", scratch)).toThrow(/dist is stale/);
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
