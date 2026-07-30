import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(repoRoot, "fixtures/external-dark-launch-product");
const sdkRoot = join(repoRoot, "packages/sdk");

/**
 * Pack `@splitch/sdk` and install it into a temp copy of the external product fixture.
 * Returns paths and a dynamic importer for the packed package.
 */
export function installPackedSdkConsumer() {
  const consumerRoot = mkdtempSync(join(tmpdir(), "splitch-dark-launch-consumer-"));
  const packDir = mkdtempSync(join(tmpdir(), "splitch-dark-launch-pack-"));

  cpSync(fixtureRoot, consumerRoot, { recursive: true });

  if (!existsSync(join(sdkRoot, "dist/index.js"))) {
    throw new Error("@splitch/sdk dist is missing; run its Turbo build before the CLI test");
  }
  const packOutput = execFileSync("node", ["scripts/pack-release.mjs", packDir], {
    cwd: sdkRoot,
    encoding: "utf8",
  });
  const tarballName = packOutput.trim().split("\n").at(-1);
  if (!tarballName?.endsWith(".tgz")) {
    throw new Error(`pack-release did not report a tarball path:\n${packOutput}`);
  }
  const tarballPath = resolve(packDir, tarballName);
  execFileSync("npm", ["install", tarballPath], {
    cwd: consumerRoot,
    stdio: "inherit",
    env: { ...process.env, npm_config_cache: join(consumerRoot, ".npm-cache") },
  });

  const packedManifest = JSON.parse(
    readFileSync(join(consumerRoot, "node_modules/@splitch/sdk/package.json"), "utf8"),
  );
  if (packedManifest.dependencies?.["@splitch/contracts"]) {
    throw new Error("packed manifest still depends on @splitch/contracts");
  }

  return {
    consumerRoot,
    tarballPath,
    installCommand: `npm install ${tarballPath}`,
    async importSdk() {
      return import(join(consumerRoot, "node_modules/@splitch/sdk/dist/index.js"));
    },
    resolveScript: join(consumerRoot, "resolve.mjs"),
    dispose() {
      rmSync(consumerRoot, { recursive: true, force: true });
      rmSync(packDir, { recursive: true, force: true });
    },
  };
}

/**
 * Run the external product resolve.mjs script and parse its JSON stdout.
 * ERROR resolutions still print ResolutionDetails and exit 2 — surface the
 * structured details so callers can assert errorCode without treating any throw
 * as success.
 */
export function runExternalResolve(consumer, action, options) {
  const args = [
    consumer.resolveScript,
    action,
    "--flag",
    options.flagKey,
    "--targeting-key",
    options.targetingKey,
  ];
  if (options.idempotencyKey) {
    args.push("--idempotency-key", options.idempotencyKey);
  }
  for (const [key, value] of Object.entries(options.attributes ?? {})) {
    args.push("--attribute", `${key}=${value}`);
  }

  let stdout;
  try {
    stdout = execFileSync(process.execPath, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        SPLITCH_CLIENT_KEY: options.clientKey,
        SPLITCH_ENDPOINT: options.endpoint,
      },
    });
  } catch (error) {
    const captured =
      error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
    const details = parseLastJsonLine(captured);
    if (details) return details;
    throw error;
  }
  const details = parseLastJsonLine(stdout);
  if (!details) {
    throw new Error(`external resolve produced no JSON details:\n${stdout}`);
  }
  return details;
}

function parseLastJsonLine(text) {
  const line = text
    .trim()
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function writeEvidence(path, evidence) {
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
}
