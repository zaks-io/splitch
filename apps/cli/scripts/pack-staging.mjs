#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_DEPENDENCIES = ["@hono/zod-openapi", "@sentry/node", "hono", "zod"];
const REQUIRED_FILES = [
  "package/LICENSE.md",
  "package/dist/cli.js",
  "package/dist/index.d.ts",
  "package/dist/index.js",
];

export function getPackageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

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
  const staging = mkdtempSync(join(tmpdir(), "splitch-cli-pack-"));
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
      throw new Error(`${fileName} is missing from @splitch/cli`);
    }
    cpSync(source, join(staging, fileName));
  }

  return staging;
}

export function packStagingDir(stagingDir, { dryRun = false, destination } = {}) {
  const args = ["pack"];
  if (dryRun) args.push("--dry-run");
  if (destination) args.push("--pack-destination", destination);
  const { stdout, stderr, status, error } = spawnSync("npm", args, {
    cwd: stagingDir,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(stagingDir, ".npm-cache") },
  });
  if (error) throw error;
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

export function assertReleaseTarballContents({ listing, manifestText, cliJs }) {
  for (const required of REQUIRED_FILES) {
    if (!listing.includes(required)) {
      throw new Error(`release tarball is missing ${required}`);
    }
  }
  for (const file of listing) {
    if (file.endsWith(".map")) {
      throw new Error(`release tarball must not include sourcemaps: ${file}`);
    }
    if (
      file !== "package/package.json" &&
      file !== "package/README.md" &&
      file !== "package/LICENSE.md" &&
      !file.startsWith("package/dist/")
    ) {
      throw new Error(`release tarball contains unexpected file: ${file}`);
    }
  }
  if (!cliJs.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("dist/cli.js must start with #!/usr/bin/env node");
  }

  const manifest = JSON.parse(manifestText);
  if (manifest.devDependencies !== undefined) {
    throw new Error("release manifest must not ship devDependencies");
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const names = Object.keys(manifest[field] ?? {});
    const workspaceName = names.find((name) => name.startsWith("@splitch/"));
    if (workspaceName) {
      throw new Error(`release manifest leaks ${workspaceName} in ${field}`);
    }
  }
  if (manifestText.includes("workspace:")) {
    throw new Error("release manifest must not contain workspace: ranges");
  }
  const dependencyKeys = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(dependencyKeys) !== JSON.stringify(EXPECTED_DEPENDENCIES)) {
    throw new Error(
      `release manifest dependencies must be exactly ${EXPECTED_DEPENDENCIES.join(", ")}; got: ${dependencyKeys.join(", ") || "(none)"}`,
    );
  }
  if (
    JSON.stringify(manifest.bin) !==
    JSON.stringify({
      splitch: "./dist/cli.js",
    })
  ) {
    throw new Error(`release manifest bin must point splitch at ./dist/cli.js`);
  }
}

export function assertDryRunListing(packOutput) {
  const lines = packOutput.split("\n").map((line) => line.trim());
  const contentsIndex = lines.findIndex(
    (line) => line === "Tarball Contents" || line === "npm notice Tarball Contents",
  );
  if (contentsIndex === -1) {
    throw new Error(`pack --dry-run output missing Tarball Contents:\n${packOutput}`);
  }

  const listing = [];
  for (let index = contentsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "Tarball Details" || line === "npm notice Tarball Details") break;
    if (!line) continue;
    const withoutNotice = line.replace(/^npm notice\s+/, "");
    const match = /^(?:\d+(?:\.\d+)?[kMG]?B\s+)?(.+)$/.exec(withoutNotice);
    if (match?.[1]) listing.push(`package/${match[1]}`);
  }

  assertReleaseTarballContents({
    listing,
    manifestText: JSON.stringify(readReleaseManifest(getPackageRoot())),
    cliJs: readFileSync(join(getPackageRoot(), "dist/cli.js"), "utf8"),
  });
}
