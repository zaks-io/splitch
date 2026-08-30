import {
  ExperimentConfigKVSchema,
  experimentConfigKey,
  kvEnvelope,
  RunConfigKVSchema,
  runConfigKey,
} from "@splitch/contracts";
import { emptyError, serviceUnavailable, validationError } from "./errors";
import type { CredentialScope, Env, Outcome, RunScope } from "./types";

const ExperimentConfigEnvelope = kvEnvelope(ExperimentConfigKVSchema);
const RunConfigEnvelope = kvEnvelope(RunConfigKVSchema);

/**
 * Validate the FIRE-TIME run identity carried in the payload. `run_id` is
 * stamped at SDK fire-time by the Evaluation Worker and is never inferred at
 * ingest time (exposure-pipeline.md, edge-ingest-contract.md §run_id stamping):
 * re-deriving it from the live-run pointer here would relabel an exposure that
 * raced a Run boundary, contaminating the new Run's first-touch counts. Run
 * config blobs persist after a Run ends (only the live-run pointer is
 * deleted), so a legitimate late exposure still validates.
 */
export async function loadRunScope(
  env: Env,
  scope: CredentialScope,
  experimentId: string,
  idType: string,
  runId: string,
): Promise<Outcome<RunScope>> {
  if (!env.CONFIG_STORE) {
    return { ok: false, error: serviceUnavailable("CONFIG_STORE binding is unavailable") };
  }

  const experiment = await readExperiment(env.CONFIG_STORE, scope, experimentId);
  if (!experiment.ok) return experiment;

  if (experiment.value.targetingKeyType !== idType) {
    return {
      ok: false,
      error: validationError("idType does not match the Experiment", ["body", "idType"]),
    };
  }

  const run = await readRun(env.CONFIG_STORE, scope, runId);
  if (!run.ok) return run;
  if (run.value.experimentId !== experimentId) {
    return { ok: false, error: emptyError("INTERNAL_SERVER_ERROR", "Run scope mismatch") };
  }

  return { ok: true, value: { runId, idType: experiment.value.targetingKeyType } };
}

async function readExperiment(
  kv: KVNamespace,
  scope: CredentialScope,
  experimentId: string,
): Promise<Outcome<{ targetingKeyType: string; liveRunId: string | null }>> {
  const raw = await kv.get(
    experimentConfigKey(scope.appId, scope.environmentId, experimentId),
    "text",
  );
  if (raw === null) {
    return { ok: false, error: emptyError("EXPERIMENT_NOT_FOUND", "Experiment config not found") };
  }

  try {
    const parsed = ExperimentConfigEnvelope.parse(JSON.parse(raw)).data;
    return { ok: true, value: parsed };
  } catch {
    return {
      ok: false,
      error: emptyError("INTERNAL_SERVER_ERROR", "Experiment config is invalid"),
    };
  }
}

async function readRun(
  kv: KVNamespace,
  scope: CredentialScope,
  runId: string,
): Promise<Outcome<{ experimentId: string }>> {
  const raw = await kv.get(runConfigKey(scope.appId, scope.environmentId, runId), "text");
  if (raw === null) {
    return { ok: false, error: emptyError("RUN_NOT_FOUND", "Run config not found") };
  }

  try {
    const parsed = RunConfigEnvelope.parse(JSON.parse(raw)).data;
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: emptyError("INTERNAL_SERVER_ERROR", "Run config is invalid") };
  }
}
