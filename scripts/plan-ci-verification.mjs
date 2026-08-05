import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { classifyProductionChanges } from "./lib/production-deploy-plan.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const ZERO_SHA = "0".repeat(40);
const GLOBAL_VALIDATION_INPUTS = new Set([
  ".github/workflows/ci.yml",
  "package.json",
  "scripts/plan-ci-verification.mjs",
  "turbo.json",
]);
// The D1 validators shell out to `pnpm exec wrangler`, so a resolved-dependency
// change can alter what they prove. The Tinybird validator cannot: `tb` is
// curl-installed rather than a workspace dependency, and check-tinybird-local.mjs
// and its helpers import node builtins only. Triggering a ~95s Tinybird spin-up
// on every lockfile bump bought nothing.
const DEPENDENCY_GRAPH_INPUTS = new Set(["pnpm-lock.yaml", "pnpm-workspace.yaml"]);
const TINYBIRD_INPUTS = new Set([
  "scripts/check-tinybird-local.mjs",
  "scripts/lib/tinybird-metric-stub-tripwire.mjs",
  "scripts/lib/tinybird-process.mjs",
  "scripts/machine-lock.mjs",
  "tinybird.config.json",
]);
const CACHE_POLICY_INPUTS = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/nightly-verify.yml",
  "scripts/check-turbo-remote-cache-env.mjs",
  "scripts/plan-ci-verification.mjs",
  "turbo.json",
]);

export function classifyCiChanges(paths) {
  const changedPaths = paths.map(normalizePath).filter(Boolean);
  const productionPlan = classifyProductionChanges(changedPaths);
  const globalValidationChanged = changedPaths.some((path) => GLOBAL_VALIDATION_INPUTS.has(path));
  const dependencyGraphChanged = changedPaths.some((path) => DEPENDENCY_GRAPH_INPUTS.has(path));

  return {
    cachePolicyChanged: changedPaths.some((path) => CACHE_POLICY_INPUTS.has(path)),
    d1:
      globalValidationChanged ||
      dependencyGraphChanged ||
      changedPaths.some(
        (path) =>
          path.startsWith("packages/db/") ||
          path === "scripts/check-d1-local.mjs" ||
          path === "scripts/check-d1-populated.mjs",
      ),
    productionVite: productionPlan.workerPackages.some(
      (name) => name === "@splitch/control-panel" || name === "@splitch/marketing",
    ),
    tinybird:
      globalValidationChanged ||
      changedPaths.some((path) => path.startsWith("infra/tinybird/") || TINYBIRD_INPUTS.has(path)),
  };
}

export function createCiVerificationPlan({
  afterSha,
  baseSha,
  beforeSha,
  eventName,
  headSha,
  runGit = defaultRunGit,
}) {
  const range = resolveRange({
    afterSha,
    baseSha,
    beforeSha,
    eventName,
    headSha,
    runGit,
  });
  if (!range.ok) return fullPlan(range.reason);

  const diff = runGit(["diff", "--name-only", range.baseSha, range.headSha]);
  if (!diff.ok) {
    return fullPlan(
      `could not diff ${range.baseSha}..${range.headSha}: ${diff.stderr || "unknown git error"}`,
    );
  }

  const changedPaths = diff.stdout.split(/\r?\n/u).map(normalizePath).filter(Boolean);
  const classification = classifyCiChanges(changedPaths);
  if (classification.cachePolicyChanged) {
    return {
      ...classification,
      baseSha: range.baseSha,
      changedPaths,
      forceFull: true,
      headSha: range.headSha,
      reason: "cache-policy inputs changed",
      useAffected: false,
    };
  }

  return {
    ...classification,
    baseSha: range.baseSha,
    changedPaths,
    forceFull: false,
    headSha: range.headSha,
    reason: `resolved ${eventName} comparison`,
    useAffected: true,
  };
}

function resolveRange({ afterSha, baseSha, beforeSha, eventName, headSha, runGit }) {
  if (eventName === "pull_request") {
    if (!isSha(baseSha) || !isSha(headSha)) {
      return failedRange("pull_request base/head SHA unavailable");
    }
    const mergeBase = runGit(["merge-base", baseSha, headSha]);
    if (!mergeBase.ok || !isSha(mergeBase.stdout)) {
      return failedRange(
        `could not resolve the pull_request merge base: ${mergeBase.stderr || "no merge base"}`,
      );
    }
    return { baseSha: mergeBase.stdout, headSha, ok: true };
  }

  if (eventName === "push") {
    if (!isSha(beforeSha) || beforeSha === ZERO_SHA || !isSha(afterSha)) {
      return failedRange("push before/after SHA unavailable");
    }
    return { baseSha: beforeSha, headSha: afterSha, ok: true };
  }

  return failedRange(`event ${eventName || "unknown"} has no trustworthy comparison`);
}

function fullPlan(reason) {
  return {
    baseSha: undefined,
    cachePolicyChanged: false,
    changedPaths: [],
    d1: true,
    forceFull: true,
    headSha: undefined,
    productionVite: true,
    reason,
    tinybird: true,
    useAffected: false,
  };
}

function failedRange(reason) {
  return { ok: false, reason };
}

function isSha(value) {
  return FULL_SHA.test(value ?? "");
}

function normalizePath(path) {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

function defaultRunGit(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    stderr: result.stderr.trim(),
    stdout: result.stdout.trim(),
  };
}

function writePlan(plan) {
  const outputPath = process.env.GITHUB_OUTPUT;
  const envPath = process.env.GITHUB_ENV;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (outputPath) {
    const outputs = {
      cache_policy_changed: plan.cachePolicyChanged,
      d1: plan.d1,
      production_vite: plan.productionVite,
      tinybird: plan.tinybird,
      use_affected: plan.useAffected,
    };
    for (const [name, value] of Object.entries(outputs)) {
      appendFileSync(outputPath, `${name}=${value}\n`);
    }
  }

  if (envPath) {
    if (plan.forceFull) appendFileSync(envPath, "TURBO_FORCE=true\n");
    if (plan.useAffected) {
      appendFileSync(envPath, `TURBO_SCM_BASE=${plan.baseSha}\n`);
      appendFileSync(envPath, `TURBO_SCM_HEAD=${plan.headSha}\n`);
    }
  }

  if (summaryPath) {
    appendFileSync(
      summaryPath,
      [
        "## CI verification plan",
        "",
        `- Mode: \`${plan.useAffected ? "affected" : "full"}\``,
        `- Changed paths: \`${plan.changedPaths.length}\``,
        `- Tinybird validation: \`${plan.tinybird}\``,
        `- D1 validation: \`${plan.d1}\``,
        `- Production Vite affected: \`${plan.productionVite}\``,
        `- Reason: ${singleLine(plan.reason)}`,
        "",
      ].join("\n"),
    );
  }

  const level = plan.forceFull ? "warning" : "notice";
  console.log(`::${level} title=CI verification plan::${singleLine(plan.reason)}`);
  console.log(JSON.stringify(plan, null, 2));
}

function singleLine(value) {
  return String(value).replace(/[\r\n]+/gu, " ");
}

function main() {
  const plan = createCiVerificationPlan({
    afterSha: process.env.PUSH_AFTER_SHA,
    baseSha: process.env.PR_BASE_SHA,
    beforeSha: process.env.PUSH_BEFORE_SHA,
    eventName: process.env.GITHUB_EVENT_NAME,
    headSha: process.env.PR_HEAD_SHA,
  });
  writePlan(plan);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
