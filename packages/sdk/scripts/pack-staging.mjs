#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function getPackageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Published manifest: workspace-only fields must not ship. */
function readReleaseManifest(packageRoot) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const {
    devDependencies: _devDependencies,
    scripts: _scripts,
    prepublishOnly: _prepublishOnly,
    postpublish: _postpublish,
    ...release
  } = manifest;
  return release;
}

export function createPackStagingDir(packageRoot) {
  const staging = mkdtempSync(join(tmpdir(), "splitch-sdk-pack-"));
  const manifest = readReleaseManifest(packageRoot);
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const distDir = join(packageRoot, "dist");
  if (!existsSync(distDir)) {
    throw new Error("dist/ is missing; run build before packing");
  }
  cpSync(distDir, join(staging, "dist"), { recursive: true });

  for (const fileName of ["LICENSE.md", "README.md"]) {
    const source = join(packageRoot, fileName);
    if (!existsSync(source)) {
      throw new Error(`${fileName} is missing from @splitch/sdk`);
    }
    cpSync(source, join(staging, fileName));
  }

  return staging;
}

export function packStagingDir(stagingDir, { dryRun = false, destination } = {}) {
  const args = ["pack"];
  if (dryRun) {
    args.push("--dry-run");
  }
  if (destination) {
    args.push("--pack-destination", destination);
  }
  const { stdout, stderr, status, error } = spawnSync("npm", args, {
    cwd: stagingDir,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(stagingDir, ".npm-cache") },
  });
  if (error) {
    throw error;
  }
  if (status !== 0) {
    throw new Error(stderr || stdout || `npm pack failed with exit code ${status}`);
  }
  return `${stdout}\n${stderr}`;
}

export function parseTarballName(packOutput) {
  const tarballLine = packOutput
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz"));
  if (!tarballLine) {
    throw new Error(`pack did not report a tarball path:\n${packOutput}`);
  }
  return tarballLine;
}

export function listTarballFiles(tarballPath) {
  return execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function readTarballFile(tarballPath, entryPath) {
  return execFileSync("tar", ["-xOf", tarballPath, entryPath], { encoding: "utf8" });
}

/** Control-plane / test-eval schema names that must never ship in the public SDK bundle. */
const FORBIDDEN_PUBLIC_BUNDLE_MARKERS = [
  "OrganizationSchema",
  "ClientKeySchema",
  "APIKeySchema",
  "TestEvaluationReasonSchema",
  "TestEvaluationResponseSchema",
  "TestEvaluationRequestSchema",
  "EnvironmentSchema",
  "ExposureEventSchema",
  "ruleName",
  "percentage_rollout",
  "holdover_replay",
  "variantWeights",
];

export function assertReleaseBundleJs(bundleJs) {
  for (const marker of FORBIDDEN_PUBLIC_BUNDLE_MARKERS) {
    if (bundleJs.includes(marker)) {
      throw new Error(`release bundle must not contain internal marker: ${marker}`);
    }
  }
  assertNoZodInBundle(bundleJs);
}

function assertNoZodInBundle(bundleJs) {
  // With `external: []` a reintroduced zod is inlined into dist, not imported.
  // The load-bearing guard is assertZeroRuntimeDependencies on the packed
  // manifest (zero runtime deps). Inlined zod source is caught by the
  // size:check byte budget, not by a metafile or source scan — these regexes
  // only catch accidental re-externalization of an import/require.
  if (
    /\bfrom\s*["']zod(?:\/[^"']*)?["']/.test(bundleJs) ||
    /\brequire\s*\(\s*["']zod/.test(bundleJs)
  ) {
    throw new Error("release bundle must not import zod (SPL-325)");
  }
  if (bundleJs.includes("zod/v4/locales")) {
    throw new Error("release bundle must not contain zod locale modules (SPL-325)");
  }
}

function assertZeroRuntimeDependencies(manifest) {
  const dependencyKeys = Object.keys(manifest.dependencies ?? {});
  if (dependencyKeys.length !== 0) {
    throw new Error(
      `release manifest must ship zero runtime dependencies; got: ${dependencyKeys.join(", ")}`,
    );
  }
}

export function assertReleaseTarballContents({ listing, manifestText, declarationText, bundleJs }) {
  for (const file of listing) {
    if (file.endsWith(".map")) {
      throw new Error(`release tarball must not include sourcemaps: ${file}`);
    }
  }
  if (!listing.some((file) => file.endsWith("dist/build-stamp.json"))) {
    throw new Error("release tarball must ship dist/build-stamp.json");
  }

  const manifest = JSON.parse(manifestText);
  if (manifest.dependencies?.["@splitch/contracts"]) {
    throw new Error("release manifest still depends on @splitch/contracts");
  }
  if (manifest.devDependencies?.["@splitch/contracts"]) {
    throw new Error("release manifest still lists @splitch/contracts in devDependencies");
  }
  assertZeroRuntimeDependencies(manifest);

  if (declarationText.includes("@splitch/contracts")) {
    throw new Error("release declarations still import @splitch/contracts");
  }

  if (manifest.devDependencies && Object.keys(manifest.devDependencies).length > 0) {
    throw new Error(
      `release manifest must not ship devDependencies: ${Object.keys(manifest.devDependencies).join(", ")}`,
    );
  }

  if (bundleJs) {
    assertReleaseBundleJs(bundleJs);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pack stdout parser with several failure modes
export function assertDryRunListing(packOutput) {
  const lines = packOutput.split("\n").map((line) => line.trim());
  const tarballContentsIndex = lines.findIndex(
    (line) => line === "Tarball Contents" || line === "npm notice Tarball Contents",
  );
  if (tarballContentsIndex === -1) {
    throw new Error(`pack --dry-run output missing Tarball Contents:\n${packOutput}`);
  }

  const listing = [];
  for (let index = tarballContentsIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === "Tarball Details" || line === "npm notice Tarball Details" || line === "") {
      if (line === "Tarball Details" || line === "npm notice Tarball Details") {
        break;
      }
      continue;
    }
    const withoutNotice = line.replace(/^npm notice\s+/, "");
    const match = /^(?:\d+(?:\.\d+)?[kMG]?B\s+)?(.+)$/.exec(withoutNotice);
    if (match) {
      listing.push(match[1]);
    }
  }

  const manifestLine = listing.find((file) => file.endsWith("package.json"));
  if (!manifestLine) {
    throw new Error("pack --dry-run listing missing package.json");
  }

  const declarationLine = listing.find((file) => file.endsWith("dist/index.d.ts"));
  if (!declarationLine) {
    throw new Error("pack --dry-run listing missing dist/index.d.ts");
  }

  for (const file of listing) {
    if (file.endsWith(".map")) {
      throw new Error(`release dry-run listing must not include sourcemaps: ${file}`);
    }
  }

  const releaseManifest = readReleaseManifest(getPackageRoot());
  const bundleJs = readFileSync(join(getPackageRoot(), "dist/index.js"), "utf8");
  assertReleaseTarballContents({
    listing,
    manifestText: JSON.stringify(releaseManifest),
    declarationText: readFileSync(join(getPackageRoot(), "dist/index.d.ts"), "utf8"),
    bundleJs,
  });
}
