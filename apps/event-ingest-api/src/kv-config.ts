import {
  ExperimentConfigKVSchema,
  RunConfigKVSchema,
  experimentConfigKey,
  kvEnvelope,
  runConfigKey,
} from "@splitch/contracts";
import { emptyError, serviceUnavailable, validationError } from "./errors";
import type { CredentialScope, Env, LiveRunConfig, Outcome } from "./types";

const ExperimentConfigEnvelope = kvEnvelope(ExperimentConfigKVSchema);
const RunConfigEnvelope = kvEnvelope(RunConfigKVSchema);

export async function loadLiveRun(
  env: Env,
  scope: CredentialScope,
  experimentId: string,
  idType: string,
): Promise<Outcome<LiveRunConfig>> {
  if (!env.CONFIG_STORE) {
    return { ok: false, error: serviceUnavailable("CONFIG_STORE binding is unavailable") };
  }

  const experiment = await readExperiment(env.CONFIG_STORE, scope, experimentId);
  if (!experiment.ok) return experiment;

  if (experiment.value.targetingKeyType !== idType) {
    return {
      ok: false,
      error: validationError("idType does not match the live Experiment Run", ["body", "idType"]),
    };
  }

  const runId = experiment.value.liveRunId;
  if (runId === null) {
    return { ok: false, error: emptyError("RUN_NOT_FOUND", "no live Run for Experiment") };
  }

  const run = await readRun(env.CONFIG_STORE, scope, runId);
  if (!run.ok) return run;
  if (run.value.experimentId !== experimentId) {
    return { ok: false, error: emptyError("INTERNAL_SERVER_ERROR", "live Run scope mismatch") };
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
