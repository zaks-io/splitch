import { spawnSync } from "node:child_process";

export function uploadSentrySourceMaps({ releaseName, missingEnv, outDir }) {
  if (missingEnv.length > 0) {
    console.warn(
      `deploy-worker-with-sentry: missing Sentry source map upload env: ${missingEnv.join(
        ", ",
      )}; skipping Sentry upload`,
    );
    return;
  }

  if (!ensureSentryRelease(releaseName)) return;
  const uploadExitCode = runForStatus("pnpm", [
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
    outDir,
  ]);
  if (uploadExitCode !== 0) {
    warnSentryFailure("source map upload", uploadExitCode);
  }
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
    return true;
  }

  const createExitCode = runForStatus("pnpm", [
    "exec",
    "sentry-cli",
    "releases",
    "new",
    ...projectArgs,
    releaseName,
  ]);
  if (createExitCode !== 0) {
    warnSentryFailure("release creation", createExitCode);
    return false;
  }
  return true;
}

function warnSentryFailure(operation, exitCode) {
  const message = `${operation} exited ${exitCode}; the Worker is deployed without confirmed Sentry source maps`;
  console.warn(`deploy-worker-with-sentry: ${message}`);
  if (process.env.CI === "true") {
    console.warn(`::warning title=Sentry source map upload failed::${message}`);
  }
}

function runForStatus(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  return result.status ?? 1;
}
