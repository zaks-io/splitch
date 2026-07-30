#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSdkReleaseTarget } from "./resolve-version.mjs";

const repoRoot = process.argv[2] ?? process.cwd();
const outputDir = process.argv[3] ?? join(repoRoot, ".sdk-release-artifacts");

const validationLogPath = join(outputDir, "validation.log");
const validationSummaryPath = join(outputDir, "validation-summary.json");
const validationStartedAt = Date.now();

mkdirSync(outputDir, { recursive: true });
writeFileSync(validationLogPath, "");
writeFileSync(
  validationSummaryPath,
  `${JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      checks: [],
    },
    null,
    2,
  )}\n`,
);

const target = resolveSdkReleaseTarget(repoRoot);
// Cacheable work goes through the turbo graph so warm caches replay instead
// of re-running; each residual check runs exactly once (the old list ran
// format/lint/typecheck twice via verify:push).
const checks = [
  {
    name: "verify-graph",
    command: ["pnpm", "exec", "turbo", "run", "//#format:check", "lint", "typecheck"],
  },
  {
    name: "sdk-test-build",
    command: ["pnpm", "exec", "turbo", "run", "test", "build", "--filter=@splitch/sdk"],
  },
  { name: "knip", command: ["pnpm", "knip"] },
  { name: "secrets-range", command: ["pnpm", "secrets:range"] },
  { name: "tinybird-local", command: ["pnpm", "tinybird:local"] },
  { name: "d1-migrate-local", command: ["pnpm", "d1:migrate:local"] },
  { name: "d1-migrate-populated", command: ["pnpm", "d1:migrate:populated"] },
  {
    name: "sdk-pack-dry-run",
    command: ["pnpm", "--filter", "@splitch/sdk", "pack", "--dry-run"],
  },
  {
    name: "sdk-pack-check",
    command: ["pnpm", "--filter", "@splitch/sdk", "pack:check"],
  },
  {
    name: "sdk-consumer-smoke",
    command: ["pnpm", "--filter", "@splitch/sdk", "test:consumer-smoke"],
  },
];

/** @type {{ name: string; status: "passed" | "failed"; durationMs: number; error?: string }[]} */
const results = [];

function log(line) {
  appendFileSync(validationLogPath, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

log(`SDK release validation for ${target.packageName}@${target.version} (${target.tag})`);

for (const check of checks) {
  const startedAt = Date.now();
  log(`\n==> ${check.name}`);
  try {
    execFileSync(check.command[0], check.command.slice(1), {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
    });
    const durationMs = Date.now() - startedAt;
    results.push({ name: check.name, status: "passed", durationMs });
    log(`OK ${check.name} (${durationMs}ms)`);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message =
      error instanceof Error && "stdout" in error
        ? `${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    results.push({ name: check.name, status: "failed", durationMs, error: message });
    log(`FAILED ${check.name} (${durationMs}ms)\n${message}`);
    writeFileSync(
      validationSummaryPath,
      `${JSON.stringify(
        {
          target,
          startedAt: new Date(validationStartedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          checks: results,
          status: "failed",
        },
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }
}

writeFileSync(
  validationSummaryPath,
  `${JSON.stringify(
    {
      target,
      startedAt: new Date(validationStartedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      checks: results,
      status: "passed",
    },
    null,
    2,
  )}\n`,
);

log("\nSDK release validation passed");
