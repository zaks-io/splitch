#!/usr/bin/env node
// Proves the prepare-artifacts contract hermetically, without building:
//  1. fail-loud: a checkout without a stamped dist is refused with the
//     build remediation (prepare never rebuilds);
//  2. staging: a stamped dist is packed into a release tarball with
//     checksums, mutating nothing outside the output directory.
// The scratch tree holds real source files plus a synthetic dist, so this
// never reads another package's live build output.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { containedPath, writeBuildStamp } from "./build-stamp.mjs";
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
  // Scratch has no turbo.json, so write/verify use the fixture-local package
  // digest — no env-var hatch into production computeSourceDigest.
  writeBuildStamp(targetKey, repoRoot);

  const outputDir = join(scratchRoot, "artifacts");
  const manifestJson = execFileSync(
    "node",
    [
      join(scriptDir, "prepare-artifacts.mjs"),
      targetKey,
      repoRoot,
      outputDir,
      "prepare-contract-test",
    ],
    {
      encoding: "utf8",
    },
  );
  const manifest = JSON.parse(manifestJson.trim().split("\n").at(-1));
  for (const artifact of [manifest.tarballName, "checksums.sha256", "tarball-contents.txt"]) {
    if (!existsSync(join(outputDir, artifact))) {
      throw new Error(`prepare-artifacts did not produce ${artifact}`);
    }
  }

  process.stdout.write("prepare-artifacts contract check passed\n");
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}
