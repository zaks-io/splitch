import { createRepository } from "@splitch/db";
import type { makeControlPlaneAuthResolver } from "./auth-resolver";
import { parseControlPanelBindingOperation } from "./control-panel-operation";
import type { ControlPlaneApiEnv } from "./env";
import { panelAnalysisFailureResponse } from "./panel-analysis-failure";
import {
  panelExperimentDetail,
  panelExperimentResults,
  panelExperimentsList,
} from "./panel-experiments";
import { unauthorized } from "./unauthorized";

/**
 * The signed-delegation route for the Panel's Experiment reads.
 *
 * The catch is the only place a `ScopedAnalysisError` becomes an HTTP refusal,
 * so the Analysis Worker's transient/permanent verdict reaches the Panel intact
 * (test/panel-experiment-results-route.test.ts drives exactly this path).
 */
export async function handleSignedPanelExperiments(
  request: Request,
  env: ControlPlaneApiEnv,
  protocol: "none" | "signed" | "bounded-session",
  authResolver: ReturnType<typeof makeControlPlaneAuthResolver>,
): Promise<Response | null> {
  if (protocol !== "signed") return null;
  const operation = parseControlPanelBindingOperation(request)?.id;
  if (
    operation !== "experiments_list" &&
    operation !== "experiments_detail" &&
    operation !== "experiments_results"
  ) {
    return null;
  }
  const auth = await authResolver(request);
  if (!auth.ok) return unauthorized();
  return handlePanelExperimentsRequest(request, env, auth.principal.id, operation);
}

async function handlePanelExperimentsRequest(
  request: Request,
  env: ControlPlaneApiEnv,
  actorId: string,
  operation: "experiments_detail" | "experiments_list" | "experiments_results",
): Promise<Response> {
  const input = await request.json().catch(() => null);
  if (!isPanelExperimentsInput(input)) {
    return Response.json(
      {
        code: "VALIDATION_ERROR",
        message: "appId and environmentId are required",
        details: {},
      },
      { status: 400 },
    );
  }
  try {
    if (operation === "experiments_list") {
      return await panelExperimentsList(
        { repo: createRepository(env.DB), analysis: env.ANALYSIS_API },
        { actorId, ...input },
      );
    }
    if (!isPanelExperimentDetailInput(input)) {
      return Response.json(
        {
          code: "VALIDATION_ERROR",
          message: "appId, environmentId, and experimentId are required",
          details: {},
        },
        { status: 400 },
      );
    }
    if (operation === "experiments_detail") {
      return await panelExperimentDetail({ repo: createRepository(env.DB) }, { actorId, ...input });
    }
    if (!isPanelExperimentResultsInput(input)) {
      return Response.json(
        { code: "VALIDATION_ERROR", message: "runId must be a non-empty string", details: {} },
        { status: 400 },
      );
    }
    return await panelExperimentResults(
      { repo: createRepository(env.DB), analysis: env.ANALYSIS_API },
      { actorId, ...input },
    );
  } catch (cause) {
    return panelAnalysisFailureResponse(cause);
  }
}

function isPanelExperimentDetailInput(value: {
  appId: string;
  environmentId: string;
}): value is { appId: string; environmentId: string; experimentId: string } {
  return (
    "experimentId" in value &&
    typeof value.experimentId === "string" &&
    value.experimentId.length > 0
  );
}

function isPanelExperimentResultsInput(value: {
  appId: string;
  environmentId: string;
  experimentId: string;
}): value is { appId: string; environmentId: string; experimentId: string; runId?: string } {
  if (!("runId" in value)) return true;
  const runId = (value as { runId: unknown }).runId;
  return runId === undefined || (typeof runId === "string" && runId.length > 0);
}

function isPanelExperimentsInput(
  value: unknown,
): value is { appId: string; environmentId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "appId" in value &&
    typeof value.appId === "string" &&
    value.appId.length > 0 &&
    "environmentId" in value &&
    typeof value.environmentId === "string" &&
    value.environmentId.length > 0
  );
}
