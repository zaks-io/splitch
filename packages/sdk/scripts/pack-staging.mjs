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
export function readReleaseManifest(packageRoot) {
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

  const licensePath = join(packageRoot, "LICENSE.md");
  if (existsSync(licensePath)) {
    cpSync(licensePath, join(staging, "LICENSE.md"));
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

export function assertReleaseTarballContents({ listing, manifestText, declarationText }) {
  for (const file of listing) {
    if (file.endsWith(".map")) {
      throw new Error(`release tarball must not include sourcemaps: ${file}`);
    }
  }

  const manifest = JSON.parse(manifestText);
  if (manifest.dependencies?.["@splitch/contracts"]) {
    throw new Error("release manifest still depends on @splitch/contracts");
  }
  if (manifest.devDependencies?.["@splitch/contracts"]) {
    throw new Error("release manifest still lists @splitch/contracts in devDependencies");
  }
  const dependencyKeys = Object.keys(manifest.dependencies ?? {});
  if (dependencyKeys.length !== 1 || dependencyKeys[0] !== "zod") {
    throw new Error(
      `release manifest dependencies must be only zod; got: ${dependencyKeys.join(", ") || "(none)"}`,
    );
  }

  if (declarationText.includes("@splitch/contracts")) {
    throw new Error("release declarations still import @splitch/contracts");
  }
}

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
    const match = /^(.+?)(?:\s+\d+(?:\.\d+)?[kMG]?B)?$/.exec(withoutNotice);
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
  assertReleaseTarballContents({
    listing,
    manifestText: JSON.stringify(releaseManifest),
    declarationText: readFileSync(join(getPackageRoot(), "dist/index.d.ts"), "utf8"),
  });
}
