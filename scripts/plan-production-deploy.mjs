import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  classifyProductionChanges,
  fullProductionPlan,
  readWorkspacePackages,
} from "./lib/production-deploy-plan.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;

export async function resolveLatestSuccessfulProductionSha({
  apiUrl,
  fetchImpl = fetch,
  repository,
  token,
}) {
  if (!apiUrl || !repository || !token) {
    throw new Error("GitHub API URL, repository, and token are required");
  }

  const deployments = await githubJson(
    fetchImpl,
    `${apiUrl}/repos/${repository}/deployments?environment=production&per_page=20`,
    token,
  );

  if (!Array.isArray(deployments)) {
    throw new Error("GitHub deployments response was not an array");
  }

  for (const deployment of deployments.filter(isValidDeployment)) {
    const statuses = await githubJson(
      fetchImpl,
      `${apiUrl}/repos/${repository}/deployments/${deployment.id}/statuses?per_page=1`,
      token,
    );
    if (Array.isArray(statuses) && statuses[0]?.state === "success") {
      return deployment.sha;
    }
  }

  return undefined;
}

export async function createProductionDeployPlan({
  apiUrl,
  baseSha,
  fetchImpl,
  forceFull = false,
  headSha,
  repository,
  runGit = defaultRunGit,
  token,
}) {
  assertSha(headSha, "release");
  const workspacePackages = readWorkspacePackages(process.cwd());
  if (forceFull) {
    return {
      ...fullProductionPlan("manual full deployment requested", workspacePackages),
      baseSha: undefined,
      headSha,
    };
  }

  let resolvedBaseSha = baseSha;
  if (!resolvedBaseSha) {
    try {
      resolvedBaseSha = await resolveLatestSuccessfulProductionSha({
        apiUrl,
        fetchImpl,
        repository,
        token,
      });
    } catch (error) {
      return {
        ...fullProductionPlan(
          `production baseline lookup failed: ${errorMessage(error)}`,
          workspacePackages,
        ),
        baseSha: undefined,
        headSha,
      };
    }
  }

  if (!resolvedBaseSha) {
    return {
      ...fullProductionPlan(
        "no successful production deployment baseline found",
        workspacePackages,
      ),
      baseSha: undefined,
      headSha,
    };
  }
  assertSha(resolvedBaseSha, "production baseline");

  if (!runGit(["merge-base", "--is-ancestor", resolvedBaseSha, headSha]).ok) {
    return {
      ...fullProductionPlan(
        "production baseline is not an ancestor of the release",
        workspacePackages,
      ),
      baseSha: resolvedBaseSha,
      headSha,
    };
  }

  const diff = runGit(["diff", "--name-only", `${resolvedBaseSha}...${headSha}`]);
  if (!diff.ok) {
    return {
      ...fullProductionPlan(
        `production diff failed: ${diff.stderr || "unknown git error"}`,
        workspacePackages,
      ),
      baseSha: resolvedBaseSha,
      headSha,
    };
  }

  const changedPaths = diff.stdout.split(/\r?\n/u).map(normalizePath).filter(Boolean);
  return {
    ...classifyProductionChanges(changedPaths, workspacePackages),
    baseSha: resolvedBaseSha,
    changedPaths,
    headSha,
  };
}

function assertSha(sha, label) {
  if (!FULL_SHA.test(sha ?? "")) {
    throw new Error(`${label} SHA must be a full commit SHA; found ${sha || "none"}`);
  }
}

function normalizePath(path) {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

function isValidDeployment(deployment) {
  return Number.isInteger(deployment?.id) && FULL_SHA.test(deployment?.sha ?? "");
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

async function githubJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }
  return response.json();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeGitHubOutputs(plan, outputPath) {
  const outputs = {
    base_sha: plan.baseSha ?? "",
    d1: String(plan.d1),
    head_sha: plan.headSha,
    reason: plan.reason,
    should_deploy: String(plan.shouldDeploy),
    tinybird: String(plan.tinybird),
    worker_packages: plan.workerPackages.join(","),
    workers: String(plan.workers),
  };

  for (const [name, value] of Object.entries(outputs)) {
    appendFileSync(outputPath, `${name}=${singleLine(value)}\n`);
  }
}

async function main() {
  const githubOutput = readEnv("GITHUB_OUTPUT");
  const headSha =
    process.env.SENTRY_RELEASE ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  const plan = await createProductionDeployPlan({
    apiUrl: readEnv("GITHUB_API_URL"),
    baseSha: readEnv("SPLITCH_PRODUCTION_BASE_SHA"),
    forceFull: readEnv("SPLITCH_FORCE_FULL_DEPLOY") === "1",
    headSha,
    repository: readEnv("GITHUB_REPOSITORY"),
    token: readEnv("GH_TOKEN"),
  });

  console.log(JSON.stringify(plan, null, 2));
  if (githubOutput) writeGitHubOutputs(plan, githubOutput);
}

function readEnv(name) {
  return process.env[name];
}

function singleLine(value) {
  return String(value).replace(/[\r\n]+/gu, " ");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(`plan-production-deploy: ${errorMessage(error)}`);
    process.exit(1);
  });
}
