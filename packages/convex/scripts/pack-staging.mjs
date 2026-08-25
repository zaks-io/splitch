import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function releaseManifest() {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const { devDependencies: _devDependencies, scripts: _scripts, ...release } = manifest;
  return release;
}

export function createStagingDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "splitch-convex-pack-"));
  const dist = join(packageRoot, "dist");
  if (!existsSync(dist)) throw new Error("dist/ is missing; run the package build first");
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(releaseManifest(), null, 2)}\n`);
  cpSync(dist, join(directory, "dist"), { recursive: true });
  for (const file of ["README.md", "LICENSE.md"])
    cpSync(join(packageRoot, file), join(directory, file));
  return directory;
}

export function pack(directory, destination, dryRun = false) {
  const args = [
    "pack",
    ...(dryRun ? ["--dry-run"] : []),
    ...(destination ? ["--pack-destination", destination] : []),
  ];
  const { stdout, stderr, status, error } = spawnSync("npm", args, {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(directory, ".npm-cache") },
  });
  if (error) throw error;
  if (status !== 0) throw new Error(stderr || stdout || `npm pack failed with exit code ${status}`);
  return `${stdout}\n${stderr}`;
}

export function tarballName(output) {
  const name = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz"));
  if (!name) throw new Error(`npm pack did not report a tarball path:\n${output}`);
  return name;
}

export function assertPackedTarball(tarballPath) {
  const listing = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
  for (const required of [
    "package/dist/build-stamp.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/react/index.js",
    "package/dist/react/index.d.ts",
    "package/dist/component/convex.config.js",
    "package/dist/component/_generated/component.d.ts",
  ]) {
    if (!listing.includes(required))
      throw new Error(`packed @splitch/convex is missing ${required}`);
  }
  if (listing.split("\n").some((file) => file.endsWith(".map"))) {
    throw new Error("packed @splitch/convex must not contain source maps");
  }
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], { encoding: "utf8" }),
  );
  const serialized = JSON.stringify(manifest);
  if (serialized.includes("workspace:"))
    throw new Error("packed @splitch/convex leaks a workspace dependency");
  if (manifest.devDependencies)
    throw new Error("packed @splitch/convex must not ship devDependencies");
  if (manifest.exports?.["./react"]?.import !== "./dist/react/index.js")
    throw new Error("packed @splitch/convex is missing its React export");
  if (manifest.peerDependenciesMeta?.react?.optional !== true)
    throw new Error("packed @splitch/convex must keep React optional for server-only consumers");
}
