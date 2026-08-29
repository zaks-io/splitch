import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PHASES = ["tinybird", "d1", "workers"];

export function classifyProductionChanges(
  paths,
  workspacePackages = readWorkspacePackages(process.cwd()),
) {
  const plan = emptyPlan();
  const unknownPaths = [];
  const workerPackages = new Set();

  for (const path of paths.map(normalizePath).filter(Boolean)) {
    const classification = classifyPath(path, workspacePackages);
    if (!classification) {
      unknownPaths.push(path);
      continue;
    }
    for (const phase of classification.phases) plan[phase] = true;
    for (const workerPackage of classification.workerPackages) {
      workerPackages.add(workerPackage);
    }
  }

  if (unknownPaths.length > 0) {
    return fullProductionPlan(
      `unclassified paths fail closed (${unknownPaths.length})`,
      workspacePackages,
      unknownPaths,
    );
  }

  const selectedPhases = PHASES.filter((phase) => plan[phase]);
  return {
    ...plan,
    shouldDeploy: selectedPhases.length > 0,
    reason:
      selectedPhases.length > 0
        ? `affected phases: ${selectedPhases.join(", ")}`
        : "no production deploy inputs changed",
    unknownPaths,
    workerPackages: [...workerPackages].sort(),
  };
}

export function fullProductionPlan(
  reason,
  workspacePackages = readWorkspacePackages(process.cwd()),
  unknownPaths = [],
) {
  return {
    d1: true,
    reason,
    shouldDeploy: true,
    tinybird: true,
    unknownPaths,
    workerPackages: deployableWorkerNames(workspacePackages),
    workers: true,
  };
}

export function readWorkspacePackages(repoRoot) {
  return ["apps", "packages"]
    .flatMap((rootName) => readWorkspaceRoot(repoRoot, rootName))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function classifyPath(path, workspacePackages) {
  if (isEmbeddedMcpResource(path)) return workerClassification(["@splitch/mcp-server"]);
  if (isNonDeployableChange(path)) return classification();
  if (isTinybirdChange(path)) return classification(["tinybird"]);
  if (isD1Change(path)) return classification(["d1"]);
  if (isCloudflareToolchainChange(path)) {
    return classification(["d1", "workers"], deployableWorkerNames(workspacePackages));
  }

  const workspacePackage = workspacePackages.find(
    (candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`),
  );
  if (workspacePackage) {
    return workerClassification(affectedWorkers(workspacePackage.name, workspacePackages));
  }

  return undefined;
}

function affectedWorkers(changedPackageName, workspacePackages) {
  const affected = new Set([changedPackageName]);
  let previousSize = -1;

  while (previousSize !== affected.size) {
    previousSize = affected.size;
    for (const workspacePackage of workspacePackages) {
      if (workspacePackage.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(workspacePackage.name);
      }
    }
  }

  return workspacePackages
    .filter(
      (workspacePackage) => workspacePackage.deployable && affected.has(workspacePackage.name),
    )
    .map((workspacePackage) => workspacePackage.name)
    .sort();
}

function deployableWorkerNames(workspacePackages) {
  return workspacePackages
    .filter((workspacePackage) => workspacePackage.deployable)
    .map((workspacePackage) => workspacePackage.name)
    .sort();
}

function readWorkspaceRoot(repoRoot, rootName) {
  const root = join(repoRoot, rootName);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packagePath = `${rootName}/${entry.name}`;
      const packageJsonPath = join(repoRoot, packagePath, "package.json");
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        return [
          {
            dependencies: workspaceDependencies(packageJson),
            deployable: typeof packageJson.scripts?.deploy === "string",
            name: packageJson.name,
            path: packagePath,
          },
        ];
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
    });
}

function workspaceDependencies(packageJson) {
  return [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ]
    .flatMap((dependencies) => Object.entries(dependencies ?? {}))
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([name]) => name);
}

function isEmbeddedMcpResource(path) {
  return path === "CONTEXT.md" || path === "scripts/generate-mcp-resource-files.mjs";
}

function isNonDeployableChange(path) {
  return (
    path.startsWith("e2e/") ||
    path.startsWith("docs/") ||
    path.startsWith(".agents/") ||
    path.startsWith(".codex/") ||
    path.startsWith(".github/") ||
    path.startsWith("scripts/release/") ||
    path === "scripts/lib/cli-mcp-contract-exceptions.ts" ||
    path === "scripts/lib/production-deploy-plan.mjs" ||
    path === "scripts/plan-ci-verification.mjs" ||
    path.endsWith(".test.mjs") ||
    path === "LICENSE" ||
    (!path.includes("/") && path.endsWith(".md")) ||
    path.endsWith("/CONTEXT.md")
  );
}

function isTinybirdChange(path) {
  return (
    path.startsWith("infra/tinybird/") ||
    path === "tinybird.config.json" ||
    path === "scripts/deploy-tinybird-production.mjs" ||
    path === "scripts/check-tinybird-local.mjs" ||
    path.startsWith("scripts/lib/tinybird-")
  );
}

function isD1Change(path) {
  return path.startsWith("packages/db/migrations/") || path === "packages/db/wrangler.jsonc";
}

function isCloudflareToolchainChange(path) {
  return [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "turbo.json",
  ].includes(path);
}

function workerClassification(workerPackages) {
  return classification(workerPackages.length > 0 ? ["workers"] : [], workerPackages);
}

function classification(phases = [], workerPackages = []) {
  return { phases, workerPackages };
}

function emptyPlan() {
  return {
    d1: false,
    tinybird: false,
    workers: false,
  };
}

function normalizePath(path) {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}
