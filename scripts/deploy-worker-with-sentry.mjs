import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigFileTextToJson } from "typescript";

const OUT_DIR = ".wrangler/sentry";
const REQUIRE_SENTRY_ENV = process.env.SPLITCH_REQUIRE_SENTRY_SOURCE_MAP_ENV === "1";
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const isDryRun = args.includes("--dry-run");
const release = resolveRelease();
const missingSentryEnv = missingSentryUploadEnv();
const wranglerArgs = [
  "exec",
  "wrangler",
  "deploy",
  "--outdir",
  OUT_DIR,
  "--upload-source-maps",
  "--var",
  `SENTRY_RELEASE:${release}`,
  ...args,
];

if (!isDryRun && REQUIRE_SENTRY_ENV && missingSentryEnv.length > 0) {
  fail(`missing Sentry source map upload env: ${missingSentryEnv.join(", ")}`);
}

run("pnpm", wranglerArgs);

if (isDryRun) {
  process.exit(0);
}

uploadSentrySourceMaps(release, missingSentryEnv);

function uploadSentrySourceMaps(releaseName, missing) {
  if (missing.length > 0) {
    console.warn(
      `deploy-worker-with-sentry: missing Sentry source map upload env: ${missing.join(
        ", ",
      )}; skipping Sentry upload`,
    );
    return;
  }

  ensureSentryRelease(releaseName);
  run("pnpm", [
    "exec",
    "sentry-cli",
    "sourcemaps",
    "upload",
    "--org",
    process.env.SENTRY_ORG,
    "--project",
    process.env.SENTRY_PROJECT,
    "--release",
    releaseName,
    "--strip-common-prefix",
    "--validate",
    "--wait-for",
    "60",
    OUT_DIR,
  ]);
}

function ensureSentryRelease(releaseName) {
  const projectArgs = ["--org", process.env.SENTRY_ORG, "--project", process.env.SENTRY_PROJECT];
  const existingRelease = spawnSync(
    "pnpm",
    ["exec", "sentry-cli", "releases", "info", ...projectArgs, "--quiet", releaseName],
    {
      stdio: "ignore",
    },
  );

  if (existingRelease.status === 0) {
    return;
  }

  run("pnpm", ["exec", "sentry-cli", "releases", "new", ...projectArgs, releaseName]);
}

function missingSentryUploadEnv() {
  return ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"].filter((name) => !process.env[name]);
}

function resolveRelease() {
  if (process.env.SENTRY_RELEASE) {
    return process.env.SENTRY_RELEASE;
  }

  const baseRelease =
    process.env.SENTRY_RELEASE_BASE ||
    commandOutput("pnpm", ["exec", "sentry-cli", "releases", "propose-version"]) ||
    commandOutput("git", ["rev-parse", "HEAD"]);

  if (!baseRelease) {
    fail("could not resolve Sentry release from sentry-cli or git");
  }

  return `${readWorkerName()}@${baseRelease}`;
}

function readWorkerName() {
  const parsed = parseConfigFileTextToJson(
    "wrangler.jsonc",
    readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8"),
  );
  if (parsed.error) {
    fail(parsed.error.messageText.toString());
  }
  const name = parsed.config?.name;
  if (typeof name !== "string" || name.length === 0) {
    fail("wrangler.jsonc must declare a Worker name");
  }
  return name;
}

function commandOutput(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  console.error(`deploy-worker-with-sentry: ${message}`);
  process.exit(1);
}
