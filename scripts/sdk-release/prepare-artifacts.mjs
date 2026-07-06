#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSdkReleaseTarget, readSdkManifest } from "./resolve-version.mjs";

const repoRoot = process.argv[2] ?? process.cwd();
const outputDir = process.argv[3] ?? join(repoRoot, ".sdk-release-artifacts");
const commitSha = process.argv[4] ?? process.env.GITHUB_SHA ?? "unknown";

mkdirSync(outputDir, { recursive: true });

const target = resolveSdkReleaseTarget(repoRoot);
const manifest = readSdkManifest(repoRoot);

const packOutput = execFileSync("node", ["scripts/pack-release.mjs", outputDir], {
  cwd: join(repoRoot, "packages/sdk"),
  encoding: "utf8",
});
const tarballName = packOutput.trim().split("\n").at(-1);
if (!tarballName?.endsWith(".tgz")) {
  throw new Error(`pack-release did not report a tarball path:\n${packOutput}`);
}

const tarballPath = join(outputDir, tarballName);
const tarballBytes = readFileSync(tarballPath);
const sha256 = createHash("sha256").update(tarballBytes).digest("hex");
const tarballContents = execFileSync("tar", ["-tzf", tarballPath], {
  encoding: "utf8",
});

writeFileSync(join(outputDir, "checksums.sha256"), `${sha256}  ${tarballName}\n`);
writeFileSync(join(outputDir, "tarball-contents.txt"), tarballContents);

const dependencyInventory = {
  package: target.packageName,
  version: target.version,
  tag: target.tag,
  commitSha,
  generatedAt: new Date().toISOString(),
  dependencies: manifest.dependencies ?? {},
  peerDependencies: manifest.peerDependencies ?? {},
  optionalDependencies: manifest.optionalDependencies ?? {},
  engines: manifest.engines ?? {},
  license: manifest.license ?? null,
  files: manifest.files ?? [],
};
writeFileSync(
  join(outputDir, "dependency-inventory.json"),
  `${JSON.stringify(dependencyInventory, null, 2)}\n`,
);

const releaseManifest = {
  ...target,
  commitSha,
  tarballName,
  sha256,
  artifactFiles: [
    tarballName,
    "checksums.sha256",
    "tarball-contents.txt",
    "dependency-inventory.json",
    "validation.log",
    "validation-summary.json",
    "release-manifest.json",
  ],
};
writeFileSync(
  join(outputDir, "release-manifest.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
);

const validationLog = join(outputDir, "validation.log");
const validationSummary = join(outputDir, "validation-summary.json");
for (const filePath of [validationLog, validationSummary]) {
  try {
    readFileSync(filePath);
  } catch {
    writeFileSync(filePath, "");
  }
}

process.stdout.write(`${JSON.stringify(releaseManifest)}\n`);
