import {
  AnalysisResultsEnvelopeSchema,
  type ConcludeRunRequest,
  canonicalHash,
  createResultToken,
  evaluateExperimentDecisionGate,
  resolveAnalysisControlIntegrity,
  resolveFrozenControlIdentity,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { fetchAnalysis } from "./analysis-binding";
import { analysisResultsRequest } from "./analysis-results-request";
import { requireAppAdmin } from "./app-authz";
import { experimentConclusionId } from "./approval-canonical";
import { idempotencyConflict as renderIdempotencyConflict } from "./approval-review-outcomes";
import { commitConclusion } from "./experiment-conclusion-commit";
import {
  decisionBlocked,
  decisionResultStale,
  decisionResultUnavailable,
} from "./experiment-conclusion-errors";
import { prepareWinnerProposal } from "./experiment-conclusion-proposal";
import { conclusionPathIds, replayConclusion } from "./experiment-conclusion-response";
import { configStoreUnavailable, runNotFound, runNotRunning } from "./experiment-errors";
import type { ExperimentDeps } from "./experiment-handler-shared";
import { objectBody } from "./handler-input";
import { type RunDurationRow, runDurationEvidence } from "./run-duration-evidence";

export async function concludeRun(
  deps: ExperimentDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const ids = conclusionPathIds(args.input);
  const adminError = await requireAppAdmin(deps, ids.appId, args.principal, args.requestId);
  if (adminError) return adminError;
  if (!deps.configStore) return configStoreUnavailable(args.requestId);
  const body = objectBody(args.input) as ConcludeRunRequest;
  const requestHash = await canonicalHash({ ...ids, ...body });
  const replay = await deps.repo.experimentConclusions.getByActorKey(
    appScope(ids.appId),
    args.principal.id,
    body.idempotencyKey,
  );
  if (replay) {
    if (replay.requestHash !== requestHash) {
      return renderIdempotencyConflict("conclusion", body.idempotencyKey, args.requestId);
    }
    return replayConclusion(deps, args, body, replay);
  }
  if (!deps.analysis) return configStoreUnavailable(args.requestId);

  const now = deps.nowIso?.() ?? new Date().toISOString();
  const conclusionId = experimentConclusionId(new Date(now).getTime());
  const prepared = await loadRunAndProposal(deps, ids, body, conclusionId, args.requestId);
  if (!prepared.ok) return prepared.response;
  const evidence = await validatedEvidence(
    deps,
    ids,
    body,
    prepared.run,
    args.principal.id,
    args.requestId,
  );
  if (!evidence.ok) return evidence.response;
  return commitConclusion(deps, args, {
    ids,
    body,
    requestHash,
    conclusionId,
    now,
    run: prepared.run,
    experiment: prepared.experiment,
    prepared: prepared.proposal,
    evidence: evidence.value,
  });
}

type ConcludedRun = RunDurationRow & {
  id: string;
  configHash: string;
  controlVariantId: string;
  variantSet: string;
  analysisVersion: string | null;
};

async function loadRunAndProposal(
  deps: ExperimentDeps,
  ids: ReturnType<typeof conclusionPathIds>,
  body: ConcludeRunRequest,
  conclusionId: string,
  requestId: string,
) {
  const scope = envScope(ids.appId, ids.environmentId);
  const run = await deps.repo.experiments.getRun(scope, ids.runId);
  if (!run || run.experimentId !== ids.experimentId) {
    return { ok: false as const, response: runNotFound(requestId) };
  }
  if (run.status !== "running") {
    return { ok: false as const, response: runNotRunning(run.id, requestId) };
  }
  const experiment = await deps.repo.experiments.getExperiment(scope, ids.experimentId);
  if (!experiment || experiment.liveRunId !== run.id) {
    return { ok: false as const, response: runNotRunning(run.id, requestId) };
  }
  const proposal = await prepareWinnerProposal(deps.repo, {
    appId: ids.appId,
    environmentId: ids.environmentId,
    experimentId: ids.experimentId,
    experimentFlagId: experiment.flagId,
    run,
    body,
    conclusionId,
    requestId,
  });
  return proposal.ok
    ? { ok: true as const, run, experiment, proposal: proposal.value }
    : { ok: false as const, response: proposal.response };
}

async function validatedEvidence(
  deps: ExperimentDeps,
  ids: ReturnType<typeof conclusionPathIds>,
  body: ConcludeRunRequest,
  run: ConcludedRun,
  actorId: string,
  requestId: string,
) {
  const response = await fetchAnalysis(
    deps.analysis as Fetcher,
    analysisResultsRequest(ids, actorId, { dataWatermark: body.dataWatermark }),
    "results_read",
  );
  if (!response.ok) return { ok: false as const, response };
  const envelope = AnalysisResultsEnvelopeSchema.parse(await response.json());
  if (envelope.state !== "ready") {
    return {
      ok: false as const,
      response: decisionResultUnavailable(run.id, envelope.state, requestId),
    };
  }
  if (!envelope.data_watermark || !envelope.result_token) {
    return {
      ok: false as const,
      response: decisionResultUnavailable(run.id, "ready", requestId),
    };
  }
  await assertEvidenceBinding(ids, body, run, envelope);
  const resultToken = envelope.result_token as `sha256:${string}`;
  if (resultToken !== body.expectedResultToken) {
    return {
      ok: false as const,
      response: decisionResultStale(
        run.id,
        body.expectedResultToken as `sha256:${string}`,
        resultToken,
        requestId,
      ),
    };
  }
  const control = resolveAnalysisControlIntegrity(
    resolveFrozenControlIdentity(run.controlVariantId, run.variantSet),
    envelope.control_variant,
  );
  // Measured against the selected watermark, never the clock, so a day-seven
  // Conclude that selects day-one evidence is refused like a day-one Conclude.
  const duration = runDurationEvidence(run, envelope.data_watermark);
  const gate = evaluateExperimentDecisionGate(envelope.stats, control, duration);
  if (!gate.shipAllowed) {
    return {
      ok: false as const,
      response: decisionBlocked(
        run.id,
        resultToken,
        envelope.data_watermark,
        envelope.stats,
        control,
        duration,
        gate,
        requestId,
      ),
    };
  }
  return {
    ok: true as const,
    value: {
      resultToken,
      dataWatermark: envelope.data_watermark,
      stats: envelope.stats,
      gate,
    },
  };
}

async function assertEvidenceBinding(
  ids: ReturnType<typeof conclusionPathIds>,
  body: ConcludeRunRequest,
  run: ConcludedRun,
  envelope: Extract<ReturnType<typeof AnalysisResultsEnvelopeSchema.parse>, { state: "ready" }>,
) {
  if (envelope.data_watermark !== body.dataWatermark) {
    throw new Error("Analysis changed the submitted conclusion watermark");
  }
  if (envelope.run_id !== ids.runId) {
    throw new Error(`Analysis answered for Run ${envelope.run_id}, not ${ids.runId}`);
  }
  // The analysis version comes from the D1 Run, not the envelope: evidence read
  // under any version other than the one the Run froze is not bound to it.
  const boundToken = await createResultToken({
    appId: ids.appId,
    environmentId: ids.environmentId,
    experimentId: ids.experimentId,
    runId: ids.runId,
    runConfigHash: run.configHash,
    analysisVersion: run.analysisVersion,
    stats: envelope.stats,
  });
  if (envelope.result_token !== boundToken) {
    throw new Error("Analysis result token is not bound to the selected Run configuration");
  }
}
