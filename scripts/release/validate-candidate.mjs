#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getReleaseTarget } from "./constants.mjs";
import { resolveReleaseTarget } from "./resolve-version.mjs";

const targetKey = process.argv[2];
getReleaseTarget(targetKey);
const repoRoot = process.argv[3] ?? process.cwd();
const outputDir = process.argv[4] ?? join(repoRoot, `.${targetKey}-release-artifacts`);

const validationLogPath = join(outputDir, "validation.log");
const validationSummaryPath = join(outputDir, "validation-summary.json");
const validationStartedAt = Date.now();

mkdirSync(outputDir, { recursive: true });

const target = resolveReleaseTarget(targetKey, repoRoot);
const targetLabel = targetKey.toUpperCase();

// One turbo graph owns candidate validation: turbo schedules independent
// tasks in parallel and replays warm caches. Tasks that write shared
// artifacts are serialized by dependsOn edges in turbo.json, not here:
// package build -> //#knip -> pack:dry-run -> pack:check -> test:consumer-smoke
// serializes package-local generated output, and the populated D1 check runs
// after the local migration check. The CLI pack chain additionally runs after
// the SDK pack chain (cli#pack:dry-run -> sdk#test:consumer-smoke): every SDK
// pack task cleans and rebuilds packages/sdk/dist, which the CLI prepack
// rebuild bundles from, so overlapping them races on that dist.
const TASKS = [
  "//#format:check",
  "lint",
  "typecheck",
  "test",
  "build",
  "//#knip",
  "//#secrets:range",
  "//#tinybird:local",
  "//#d1:migrate:local",
  "//#d1:migrate:populated",
  "pack:dry-run",
  "pack:check",
  "test:consumer-smoke",
];

process.stdout.write(
  `${targetLabel} release validation for ${target.packageName}@${target.version} (${target.tag})\n`,
);

let turboFailure;
try {
  execFileSync("pnpm", ["exec", "turbo", "run", ...TASKS, "--continue", "--summarize"], {
    cwd: repoRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CI: "true" },
  });
} catch (error) {
  turboFailure = error instanceof Error ? error.message : String(error);
}

function latestTurboRunSummary() {
  const runsDir = join(repoRoot, ".turbo", "runs");
  const files = readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error("turbo --summarize produced no run summary in .turbo/runs");
  }
  return {
    path: join(runsDir, latest),
    summary: JSON.parse(readFileSync(join(runsDir, latest), "utf8")),
  };
}

const { path: turboSummaryPath, summary: turboSummary } = latestTurboRunSummary();
copyFileSync(turboSummaryPath, join(outputDir, "turbo-run-summary.json"));

const checks = (turboSummary.tasks ?? []).map((task) => {
  const exitCode = task.execution?.exitCode;
  const startedAt = task.execution?.startTime;
  const endedAt = task.execution?.endTime;
  return {
    name: task.taskId ?? `${task.package}#${task.task}`,
    status: exitCode === 0 ? "passed" : "failed",
    durationMs:
      typeof startedAt === "number" && typeof endedAt === "number" ? endedAt - startedAt : 0,
    cache: task.cache?.status ?? "unknown",
  };
});

if (checks.length === 0) {
  throw new Error("turbo run summary contained no tasks; validation evidence is empty");
}

const failed = checks.filter((check) => check.status === "failed");
const status = turboFailure || failed.length > 0 ? "failed" : "passed";

const logLines = [
  `${targetLabel} release validation for ${target.packageName}@${target.version} (${target.tag})`,
  "",
  ...checks.map(
    (check) =>
      `${check.status === "passed" ? "OK" : "FAILED"} ${check.name} (${check.durationMs}ms, cache ${check.cache})`,
  ),
  "",
  status === "passed"
    ? `${targetLabel} release validation passed`
    : `${targetLabel} release validation FAILED`,
];
writeFileSync(validationLogPath, `${logLines.join("\n")}\n`);

writeFileSync(
  validationSummaryPath,
  `${JSON.stringify(
    {
      target,
      startedAt: new Date(validationStartedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      checks,
      status,
      ...(turboFailure ? { error: turboFailure } : {}),
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`\n${logLines.at(-1)}\n`);
if (status === "failed") {
  process.exit(1);
}
