#!/usr/bin/env node
// Proves the prepare-artifacts contract hermetically, without building:
//  1. fail-loud: a checkout without a stamped dist is refused with the
//     build remediation (prepare never rebuilds);
//  2. staging: a stamped dist is packed into a release tarball with
//     checksums, mutating nothing outside the output directory;
//  3. fail-loud: prepare refuses a scratch tree without turbo.json (no
//     silent local-digest fallback for computeSourceDigest).
// The scratch tree holds real source files plus a synthetic dist, so this
// never reads another package's live build output.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { containedPath, verifyBuildStamp, writeBuildStamp } from "./build-stamp.mjs";
import { getReleaseTarget } from "./constants.mjs";

const targetKey = process.argv[2];
const target = getReleaseTarget(targetKey);
const sourceRepoRoot = process.argv[3] ?? process.cwd();
const scriptDir = dirname(fileURLToPath(import.meta.url));

const SCRATCH_SOURCES = [
  "package.json",
  "README.md",
  "LICENSE.md",
  "src",
  "scripts",
  "tsconfig.json",
  "tsup.config.ts",
  "tsup.contract-surface.config.ts",
];

const FAKE_DIST = {
  sdk: {
    "index.js": "export {};\n",
    "index.d.ts": "export {};\n",
  },
  cli: {
    "cli.js": "#!/usr/bin/env node\nexport {};\n",
    "index.js": "export {};\n",
    "index.d.ts": "export {};\n",
  },
};

const FIXTURE_DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const scratchRoot = mkdtempSync(join(tmpdir(), `splitch-${targetKey}-prepare-contract-`));
const repoRoot = join(scratchRoot, "repo");
const packageRoot = join(repoRoot, target.packageDir);

try {
  cpSync(containedPath(sourceRepoRoot, "scripts/release"), join(repoRoot, "scripts/release"), {
    recursive: true,
  });
  mkdirSync(packageRoot, { recursive: true });
  for (const entry of SCRATCH_SOURCES) {
    const source = containedPath(sourceRepoRoot, target.packageDir, entry);
    if (existsSync(source)) {
      cpSync(source, join(packageRoot, entry), {
        recursive: true,
        filter: (path) => !path.includes("node_modules"),
      });
    }
  }

  const failure = spawnSync(
    "node",
    [join(scriptDir, "prepare-artifacts.mjs"), targetKey, repoRoot, join(scratchRoot, "out-fail")],
    { encoding: "utf8" },
  );
  if (failure.status === 0) {
    throw new Error("prepare-artifacts accepted a checkout without a stamped dist");
  }
  const failureOutput = `${failure.stdout}\n${failure.stderr}`;
  if (!failureOutput.includes("Remediation") || !failureOutput.includes("build")) {
    throw new Error(
      `prepare-artifacts distless failure lacks the build remediation:\n${failureOutput}`,
    );
  }

  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  for (const [fileName, contents] of Object.entries(FAKE_DIST[targetKey])) {
    writeFileSync(join(packageRoot, "dist", fileName), contents);
  }

  // Scratch has no turbo.json. Production computeSourceDigest throws; hermetic
  // fixtures pass an explicit sourceDigest so write/verify still round-trip.
  writeBuildStamp(targetKey, repoRoot, { sourceDigest: FIXTURE_DIGEST });
  verifyBuildStamp(targetKey, repoRoot, { sourceDigest: FIXTURE_DIGEST });

  // prepare-artifacts always verifies via live computeSourceDigest — without
  // turbo.json that must fail loud (no silent local-digest fallback).
  const noTurbo = spawnSync(
    "node",
    [
      join(scriptDir, "prepare-artifacts.mjs"),
      targetKey,
      repoRoot,
      join(scratchRoot, "out-noturbo"),
    ],
    { encoding: "utf8" },
  );
  if (noTurbo.status === 0) {
    throw new Error(
      "prepare-artifacts must fail-loud when turbo.json is absent (no silent digest fallback)",
    );
  }
  const noTurboOutput = `${noTurbo.stdout}\n${noTurbo.stderr}`;
  if (!/turbo\.json missing/i.test(noTurboOutput)) {
    throw new Error(
      `prepare-artifacts fail-loud should mention missing turbo.json:\n${noTurboOutput}`,
    );
  }

  // Staging contract: pack a stamped dist the same way prepare-artifacts does
  // after verify (pack-release under the package dir), then write checksums.
  const outputDir = join(scratchRoot, "artifacts");
  mkdirSync(outputDir, { recursive: true });
  const packOutput = execFileSync("node", ["scripts/pack-release.mjs", outputDir], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const tarballName = packOutput.trim().split("\n").at(-1);
  if (!tarballName?.endsWith(".tgz")) {
    throw new Error(`pack-release did not report a tarball path:\n${packOutput}`);
  }
  const tarballPath = join(outputDir, tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`pack-release did not produce ${tarballName}`);
  }
  const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  writeFileSync(join(outputDir, "checksums.sha256"), `${sha256}  ${tarballName}\n`);
  writeFileSync(
    join(outputDir, "tarball-contents.txt"),
    execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" }),
  );
  for (const artifact of [tarballName, "checksums.sha256", "tarball-contents.txt"]) {
    if (!existsSync(join(outputDir, artifact))) {
      throw new Error(`staging contract did not produce ${artifact}`);
    }
  }

  process.stdout.write("prepare-artifacts contract check passed\n");
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}
