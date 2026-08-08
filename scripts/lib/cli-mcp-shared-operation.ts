import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../apps/cli/src/cli.js";
import { storedCredential } from "../../apps/cli/src/test-fixtures.js";
import { handleMcpServerRequest } from "../../apps/mcp-server/src/mcp-handler.js";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "../../apps/mcp-server/src/mcp-test-verifier.js";

/**
 * SPL-313: MCP used to dispatch by `route.owner`, so an Analysis-owned operation
 * reached the Analysis Worker directly and answered differently from the CLI,
 * which addresses every management operation at the Control Plane. Running one
 * shared operation through both skins against the same Control Plane is the only
 * check that fails when the two surfaces drift again.
 */

const APP_ID = "app_1";
const ENVIRONMENT_ID = "env_1";
const CONTROL_PLANE_ORIGIN = "http://control-plane.parity.test";
const AUTH_ORIGIN = "http://auth.parity.test";
const OPERATION_ID = "experiment_results_get";

interface ControlPlaneReply {
  readonly status: number;
  readonly body: unknown;
}

interface Scenario {
  readonly name: string;
  readonly experimentId: string;
  readonly environmentId: string;
  readonly reply: ControlPlaneReply;
  /** What each surface must publish, so an equal-but-empty comparison still fails. */
  readonly expected: { readonly status: number; readonly code: string | null };
}

interface OperationCall {
  readonly request: string;
  readonly status: number;
}

interface SurfaceOutcome {
  readonly request: string;
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;
}

const noRunEnvelope = { state: "no_run", recommended_action: "START_A_RUN" };

const scenarios: readonly Scenario[] = [
  {
    name: "draft Experiment answers no_run",
    experimentId: "exp_draft",
    environmentId: ENVIRONMENT_ID,
    reply: { status: 200, body: noRunEnvelope },
    expected: { status: 200, code: null },
  },
  {
    name: "nonexistent Experiment answers EXPERIMENT_NOT_FOUND",
    experimentId: "exp_missing",
    environmentId: ENVIRONMENT_ID,
    reply: {
      status: 404,
      body: { code: "EXPERIMENT_NOT_FOUND", message: "Experiment not found", details: {} },
    },
    expected: { status: 404, code: "EXPERIMENT_NOT_FOUND" },
  },
  {
    name: "a canned out-of-scope Environment refusal is wired identically through both skins",
    experimentId: "exp_draft",
    environmentId: "env_other_app",
    reply: {
      status: 403,
      body: { code: "FORBIDDEN", message: "Environment is not in scope", details: {} },
    },
    expected: { status: 403, code: "FORBIDDEN" },
  },
];

export async function assertSharedOperationParity(): Promise<number> {
  for (const scenario of scenarios) {
    const cli = await runThroughCli(scenario);
    const mcp = await runThroughMcp(scenario);
    for (const [surface, outcome] of [
      ["CLI", cli],
      ["MCP", mcp],
    ] as const) {
      assert.deepStrictEqual(
        { status: outcome.status, code: outcome.code },
        scenario.expected,
        `cli-mcp-shared-operation: ${surface} did not publish the expected answer for ${OPERATION_ID} (${scenario.name})`,
      );
    }
    for (const field of ["request", "status", "code", "body"] as const) {
      assert.deepStrictEqual(
        mcp[field],
        cli[field],
        `cli-mcp-shared-operation: ${OPERATION_ID} (${scenario.name}) ${field} differs between surfaces\n` +
          `  CLI: ${JSON.stringify(cli[field])}\n  MCP: ${JSON.stringify(mcp[field])}`,
      );
    }
  }
  return scenarios.length;
}

/**
 * One Control Plane for both skins. Only the results call is recorded: the CLI
 * resolves its App and Environment selectors first. This fake proves both skins
 * publish the same canned Control Plane response; it is not an isolation test.
 */
function controlPlaneFetch(scenario: Scenario, seen: OperationCall[]): typeof fetch {
  const path = `/apps/${APP_ID}/envs/${scenario.environmentId}/experiments/${scenario.experimentId}/results`;
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/oauth2/token") {
      return Response.json({
        access_token: "parity-access-token",
        refresh_token: "parity-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (request.method === "GET" && url.pathname === `/apps/${APP_ID}/envs`) {
      return Response.json({ items: environmentCatalog() });
    }
    const target = `${request.method} ${url.pathname}${url.search}`;
    if (request.method === "GET" && url.pathname === path) {
      seen.push({ request: target, status: scenario.reply.status });
      return Response.json(scenario.reply.body, { status: scenario.reply.status });
    }
    seen.push({ request: target, status: 400 });
    return Response.json(
      { code: "VALIDATION_ERROR", message: `unexpected ${request.method} ${url.pathname}` },
      { status: 400 },
    );
  };
}

function environmentCatalog() {
  const stamp = "2026-07-03T00:00:00.000Z";
  const policy = {
    variantAvailability: "allow",
    targetingRolloutValue: "allow",
    enabledState: "allow",
    startExperimentRun: "allow",
  };
  return [
    { id: ENVIRONMENT_ID, key: "dev", name: "Dev" },
    { id: "env_other_app", key: "other", name: "Other" },
  ].map((environment) => ({
    ...environment,
    appId: APP_ID,
    policy,
    createdAt: stamp,
    updatedAt: stamp,
  }));
}

async function runThroughCli(scenario: Scenario): Promise<SurfaceOutcome> {
  const seen: OperationCall[] = [];
  const dir = await mkdtemp(join(tmpdir(), "splitch-cli-mcp-parity-"));
  const credentialPath = join(dir, ".splitch", "credentials.json");
  await mkdir(join(dir, ".splitch"), { recursive: true });
  await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);

  const stdout: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  // The human-readable refusal goes to stderr; `--json` puts the machine answer
  // on stdout, and that is the surface the comparison holds to.
  console.error = () => {};
  try {
    await runCli(
      [
        "experiment-results",
        "get",
        "--json",
        "--app",
        APP_ID,
        "--env",
        scenario.environmentId,
        scenario.experimentId,
      ],
      {
        credentialPath,
        env: {},
        fetch: controlPlaneFetch(scenario, seen),
        platformTarget: "local",
        controlPlaneBaseUrl: CONTROL_PLANE_ORIGIN,
        authBaseUrl: AUTH_ORIGIN,
      },
    );
  } finally {
    console.log = log;
    console.error = error;
    await rm(dir, { recursive: true, force: true });
  }

  const call = requireOneCall("CLI", seen);
  const body: unknown = stdout.length === 0 ? null : JSON.parse(stdout.join("\n"));
  return { request: call.request, status: call.status, code: errorCode(body), body };
}

async function runThroughMcp(scenario: Scenario): Promise<SurfaceOutcome> {
  const seen: OperationCall[] = [];
  const response = await handleMcpServerRequest({
    request: new Request("https://mcp.parity.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer parity-token", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: OPERATION_ID,
          arguments: {
            appId: APP_ID,
            environmentId: scenario.environmentId,
            experimentId: scenario.experimentId,
          },
        },
      }),
    }),
    service: "splitch-mcp-server",
    platformTarget: "local",
    authBaseUrl: AUTH_ORIGIN,
    controlPlaneBaseUrl: CONTROL_PLANE_ORIGIN,
    controlPlaneFetch: controlPlaneFetch(scenario, seen),
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    tokenVerifier: staticMcpTokenVerifier(),
    revocations: allowMcpRevocations(),
  });
  const payload = (await response.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean };
  };
  const structured = payload.result?.structuredContent;

  const call = requireOneCall("MCP", seen);
  const body = structured ?? null;
  return { request: call.request, status: call.status, code: errorCode(body), body };
}

function requireOneCall(surface: string, seen: readonly OperationCall[]): OperationCall {
  if (seen.length !== 1) {
    throw new Error(
      `cli-mcp-shared-operation: ${surface} sent ${seen.length} Control Plane operation requests: ${JSON.stringify(seen)}`,
    );
  }
  return seen[0] as OperationCall;
}

/**
 * Both skins publish the contract error code inside the machine-readable answer,
 * so it is the one refusal field a cross-surface comparison can hold them to.
 */
function errorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("code" in body)) return null;
  return String((body as { code: unknown }).code);
}
