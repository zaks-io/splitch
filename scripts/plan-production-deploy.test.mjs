import assert from "node:assert/strict";
import test from "node:test";
import { classifyProductionChanges, readWorkspacePackages } from "./lib/production-deploy-plan.mjs";
import {
  createProductionDeployPlan,
  resolveLatestSuccessfulProductionSha,
} from "./plan-production-deploy.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

test("documentation and non-deployable application changes skip production mutation", () => {
  assert.deepEqual(
    classifyProductionChanges([
      "docs/spec/platform/deployment-pipeline.md",
      "docs/spec/quickstart.md",
      ".github/workflows/deploy-production.yml",
    ]),
    {
      d1: false,
      reason: "no production deploy inputs changed",
      shouldDeploy: false,
      tinybird: false,
      unknownPaths: [],
      workerPackages: [],
      workers: false,
    },
  );
});

/**
 * `packages/sdk` and `apps/cli` were both in the case above until three edges
 * appeared. SPL-123 made `@splitch/sdk` a runtime dependency of the Control
 * Panel: `apps/control-panel/src/lib/panel-verify.ts` imports
 * `createSplitchClient` and the built Worker bundle inlines it. SPL-247 then
 * made the marketing site depend on both packages so `/docs/error/{code}`
 * covers every code the SDK and CLI can emit, and the compiler fails the build
 * on an undocumented one. SPL-494 declared `@splitch/sdk` as a workspace
 * dependency of Evaluation API because the Worker tests already rely on it;
 * the planner follows `devDependencies`, so SDK source changes must deploy
 * that Worker. Asserting the real edges is worth more than the old
 * assumption, and it fails loudly if any of these dependencies is ever dropped.
 */
test("SDK source changes deploy the Workers that depend on the SDK", () => {
  const evaluationApi = readWorkspacePackages(process.cwd()).find(
    (workspacePackage) => workspacePackage.name === "@splitch/evaluation-api",
  );
  assert.ok(
    evaluationApi?.dependencies.includes("@splitch/sdk"),
    "Evaluation API must keep declaring @splitch/sdk so SDK changes deploy that Worker",
  );

  const plan = classifyProductionChanges(["packages/sdk/src/index.ts"]);

  assert.equal(plan.shouldDeploy, true);
  assert.equal(plan.workers, true);
  assert.deepEqual(plan.workerPackages, [
    "@splitch/control-panel",
    "@splitch/evaluation-api",
    "@splitch/marketing",
  ]);
  assert.equal(plan.tinybird, false);
  assert.equal(plan.d1, false);
});

test("CLI source changes deploy the marketing Worker that documents its error codes", () => {
  const plan = classifyProductionChanges(["apps/cli/src/index.ts"]);

  assert.equal(plan.shouldDeploy, true);
  assert.equal(plan.workers, true);
  assert.deepEqual(plan.workerPackages, ["@splitch/marketing"]);
  assert.equal(plan.tinybird, false);
  assert.equal(plan.d1, false);
});

test("embedded runtime agent resources deploy only the MCP Worker", () => {
  const plan = classifyProductionChanges(["CONTEXT.md"]);

  assert.equal(plan.shouldDeploy, true);
  assert.equal(plan.workers, true);
  assert.deepEqual(plan.workerPackages, ["@splitch/mcp-server"]);
});

test("spec-only changes never trigger production deployment", () => {
  const plan = classifyProductionChanges([
    "docs/spec/quickstart.md",
    "docs/spec/platform/deployment-pipeline.md",
  ]);

  assert.equal(plan.shouldDeploy, false);
  assert.equal(plan.workers, false);
  assert.deepEqual(plan.workerPackages, []);
});

test("selects only the Tinybird phase for Tinybird datafiles", () => {
  const plan = classifyProductionChanges(["infra/tinybird/datasources/raw_events.datasource"]);

  assert.equal(plan.shouldDeploy, true);
  assert.equal(plan.tinybird, true);
  assert.equal(plan.d1, false);
  assert.equal(plan.workers, false);
});

test("selects only the D1 phase for migrations", () => {
  const plan = classifyProductionChanges(["packages/db/migrations/0015_example.sql"]);

  assert.equal(plan.shouldDeploy, true);
  assert.equal(plan.tinybird, false);
  assert.equal(plan.d1, true);
  assert.equal(plan.workers, false);
});

test("selects only the directly affected application Worker", () => {
  const plan = classifyProductionChanges(["apps/evaluation-api/src/index.ts"]);

  assert.equal(plan.shouldDeploy, true);
  assert.equal(plan.tinybird, false);
  assert.equal(plan.d1, false);
  assert.equal(plan.workers, true);
  assert.deepEqual(plan.workerPackages, ["@splitch/evaluation-api"]);
});

test("follows workspace dependencies to affected Workers", () => {
  const plan = classifyProductionChanges(["packages/stats/src/index.ts"]);

  assert.deepEqual(plan.workerPackages, ["@splitch/analysis-api"]);
});

test("Cloudflare toolchain changes select D1 and Workers", () => {
  const plan = classifyProductionChanges(["pnpm-lock.yaml", "turbo.json"]);

  assert.equal(plan.shouldDeploy, true);
  assert.equal(plan.tinybird, false);
  assert.equal(plan.d1, true);
  assert.equal(plan.workers, true);
  assert.equal(plan.workerPackages.length, 8);
});

test("unclassified paths fail closed to a full deployment", () => {
  const plan = classifyProductionChanges(["infrastructure/unknown.tf"]);

  assert.equal(plan.shouldDeploy, true);
  assert.equal(plan.tinybird, true);
  assert.equal(plan.d1, true);
  assert.equal(plan.workers, true);
  assert.equal(plan.workerPackages.length, 8);
  assert.deepEqual(plan.unknownPaths, ["infrastructure/unknown.tf"]);
  assert.match(plan.reason, /fail closed/u);
});

test("uses the latest deployment whose latest status succeeded", async () => {
  const calls = [];
  const responses = new Map([
    [
      "https://api.github.test/repos/zaks-io/splitch/deployments?environment=production&per_page=20",
      [
        { id: 2, sha: "c".repeat(40) },
        { id: 1, sha: baseSha },
      ],
    ],
    [
      "https://api.github.test/repos/zaks-io/splitch/deployments/2/statuses?per_page=1",
      [{ state: "failure" }],
    ],
    [
      "https://api.github.test/repos/zaks-io/splitch/deployments/1/statuses?per_page=1",
      [{ state: "success" }],
    ],
  ]);
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      json: async () => responses.get(url),
      ok: responses.has(url),
      status: responses.has(url) ? 200 : 404,
    };
  };

  const resolved = await resolveLatestSuccessfulProductionSha({
    apiUrl: "https://api.github.test",
    fetchImpl,
    repository: "zaks-io/splitch",
    token: "test-token",
  });

  assert.equal(resolved, baseSha);
  assert.equal(calls.length, 3);
});

test("plans the exact production commit range", async () => {
  const calls = [];
  const plan = await createProductionDeployPlan({
    baseSha,
    headSha,
    runGit(args) {
      calls.push(args);
      if (args[0] === "merge-base") return { ok: true, stderr: "", stdout: "" };
      return {
        ok: true,
        stderr: "",
        stdout: "docs/vision.md\napps/analysis-api/src/index.ts\n",
      };
    },
  });

  assert.deepEqual(calls, [
    ["merge-base", "--is-ancestor", baseSha, headSha],
    ["diff", "--name-only", `${baseSha}...${headSha}`],
  ]);
  assert.equal(plan.baseSha, baseSha);
  assert.equal(plan.headSha, headSha);
  assert.equal(plan.workers, true);
  assert.deepEqual(plan.workerPackages, ["@splitch/analysis-api"]);
  assert.equal(plan.tinybird, false);
  assert.equal(plan.d1, false);
});

test("missing or divergent production baselines fail closed", async () => {
  const missing = await createProductionDeployPlan({
    apiUrl: "https://api.github.test",
    fetchImpl: async () => ({ json: async () => [], ok: true, status: 200 }),
    headSha,
    repository: "zaks-io/splitch",
    token: "test-token",
  });
  assert.equal(missing.shouldDeploy, true);
  assert.equal(missing.tinybird, true);
  assert.equal(missing.d1, true);
  assert.equal(missing.workers, true);

  const divergent = await createProductionDeployPlan({
    baseSha,
    headSha,
    runGit: () => ({ ok: false, stderr: "", stdout: "" }),
  });
  assert.match(divergent.reason, /not an ancestor/u);
  assert.equal(divergent.shouldDeploy, true);
});

test("manual force bypasses baseline lookup and selects the full fleet", async () => {
  const plan = await createProductionDeployPlan({
    fetchImpl: async () => {
      throw new Error("baseline lookup should not run");
    },
    forceFull: true,
    headSha,
  });

  assert.equal(plan.reason, "manual full deployment requested");
  assert.equal(plan.tinybird, true);
  assert.equal(plan.d1, true);
  assert.equal(plan.workerPackages.length, 8);
});
