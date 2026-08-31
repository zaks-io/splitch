import { timingSafeEqualString } from "@splitch/worker-runtime";
import { emptyError, renderError, serviceUnavailable } from "./errors";
import { evaluationUsageReplayWindow } from "./evaluation-usage-replay-window";
import { ingestAdmissionCost, rejectIngestAdmission } from "./ingest-admission";
import { createIngestPhaseTiming, ingestTimingOutcomeFor } from "./ingest-phase-timing";
import { loadRunScope } from "./kv-config";
import { readJsonObject, stringField } from "./payload";
import { enqueueRawEvent } from "./raw-event-queue-envelope";
import {
  evaluationUsageEvent,
  exposureEvent,
  toEvaluationUsageTinybirdRow,
  toTinybirdRow,
} from "./tinybird";
import type { CredentialScope, Env, EvaluationUsageScope, Outcome } from "./types";

/** The three body fields that identify the fire-time Run scope. */
export function requiredIdentity(
  payload: Record<string, unknown>,
): Outcome<{ experimentId: string; idType: string; runId: string }> {
  const experimentId = stringField(payload, "experimentId");
  if (!experimentId.ok) return experimentId;
  const idType = stringField(payload, "idType");
  if (!idType.ok) return idType;
  const runId = stringField(payload, "runId");
  if (!runId.ok) return runId;
  return {
    ok: true,
    value: { experimentId: experimentId.value, idType: idType.value, runId: runId.value },
  };
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  const timing = createIngestPhaseTiming(env, { route: "internal_exposure", stream: "raw_events" });
  const credential = await timing.measure("auth", () => credentialScope(request, env));
  if (!credential.ok) return timedResponse(timing, renderError(credential.error));

  const payload = await timing.measure("parse", () => readJsonObject(request));
  if (!payload.ok) return timedResponse(timing, renderError(payload.error));

  const fields = await timing.measure("identity", () => requiredIdentity(payload.value));
  if (!fields.ok) return timedResponse(timing, renderError(fields.error));

  // The payload's runId is the SDK fire-time stamp — validated against its own
  // Run config, never replaced by the ingest-time live-run pointer.
  const runScope = await timing.measure("config", () =>
    loadRunScope(
      env,
      credential.value,
      fields.value.experimentId,
      fields.value.idType,
      fields.value.runId,
    ),
  );
  if (!runScope.ok) return timedResponse(timing, renderError(runScope.error));

  const event = await timing.measure("event", () =>
    exposureEvent(payload.value, credential.value, runScope.value, env),
  );
  if (!event.ok) return timedResponse(timing, renderError(event.error));
  const row = await timing.measure("row", () => toTinybirdRow(event.value, payload.value));
  const denied = await timing.measure("admission", () =>
    rejectIngestAdmission(
      env.INGEST_ADMISSION_GATE,
      {
        appId: credential.value.appId,
        environmentId: credential.value.environmentId,
        ingestStream: "raw_events",
      },
      [row],
      "Exposure ingest admission capacity exceeded",
    ),
  );
  if (denied) return timedResponse(timing, denied);

  try {
    await timing.measure("queue", () => enqueueRawEvent(env, "raw_events", row));
  } catch (error) {
    console.error("event-ingest-api Exposure queue handoff failed", {
      appId: event.value.appId,
      environmentId: event.value.environmentId,
      experimentId: event.value.experimentId,
      runId: event.value.runId,
      eventId: event.value.eventId,
      type: event.value.type,
      errorMessage: error instanceof Error ? error.message : "non-error rejection",
    });
    timing.emit("fault", { serializedBytes: ingestAdmissionCost([row]).byteCost });
    return renderError(serviceUnavailable("raw event queue handoff failed"));
  }

  timing.emit("accepted", { serializedBytes: ingestAdmissionCost([row]).byteCost });
  return Response.json(
    { ok: true, eventId: event.value.eventId, runId: event.value.runId },
    { status: 202 },
  );
}

export async function handleEvaluationIngest(request: Request, env: Env): Promise<Response> {
  const timing = createIngestPhaseTiming(env, {
    route: "internal_evaluation_usage",
    stream: "raw_evaluations",
  });
  const scope = await timing.measure("auth", () => evaluationUsageScope(request, env));
  if (!scope.ok) return timedResponse(timing, renderError(scope.error));

  const payload = await timing.measure("parse", () => readJsonObject(request));
  if (!payload.ok) return timedResponse(timing, renderError(payload.error));

  const event = await timing.measure("row", () =>
    evaluationUsageEvent(
      payload.value,
      scope.value,
      evaluationUsageReplayWindow(env.EVALUATION_USAGE_REPLAY_WINDOW),
    ),
  );
  if (!event.ok) return timedResponse(timing, renderError(event.error));

  const row = toEvaluationUsageTinybirdRow(event.value);
  const denied = await timing.measure("admission", () =>
    rejectIngestAdmission(
      env.INGEST_ADMISSION_GATE,
      {
        appId: scope.value.appId,
        environmentId: scope.value.environmentId,
        ingestStream: "raw_evaluations",
      },
      [row],
      "Evaluation usage ingest admission capacity exceeded",
    ),
  );
  if (denied) return timedResponse(timing, denied);

  try {
    await timing.measure("queue", () => enqueueRawEvent(env, "raw_evaluations", row));
  } catch (error) {
    console.error("event-ingest-api Evaluation queue handoff failed", {
      organizationId: event.value.organizationId,
      appId: event.value.appId,
      environmentId: event.value.environmentId,
      errorMessage: error instanceof Error ? error.message : "non-error rejection",
    });
    timing.emit("fault", { serializedBytes: ingestAdmissionCost([row]).byteCost });
    return renderError(serviceUnavailable("Evaluation usage queue handoff failed"));
  }

  timing.emit("accepted", { serializedBytes: ingestAdmissionCost([row]).byteCost });
  return Response.json({ ok: true, eventId: event.value.eventId }, { status: 202 });
}

function timedResponse(timing: ReturnType<typeof createIngestPhaseTiming>, response: Response) {
  timing.emit(ingestTimingOutcomeFor(response), { serializedBytes: null });
  return response;
}

async function credentialScope(request: Request, env: Env): Promise<Outcome<CredentialScope>> {
  const authenticated = await authenticateInternalIngestToken(request, env);
  if (!authenticated.ok) return authenticated;

  const appId = request.headers.get("x-splitch-app-id");
  const environmentId = request.headers.get("x-splitch-environment-id");

  if (!appId || !environmentId) {
    return {
      ok: false,
      error: emptyError("UNAUTHORIZED", "missing internal credential scope"),
    };
  }

  return { ok: true, value: { appId, environmentId } };
}

/**
 * Defense in depth on the binding door. The public hostname never mounts these
 * routes; a leaked bearer still cannot select App or Environment scope until
 * this compare succeeds, and the presented token is never logged.
 */
async function authenticateInternalIngestToken(request: Request, env: Env): Promise<Outcome<true>> {
  const internalToken = env.SPLITCH_EVENT_INGEST_TOKEN;
  if (!internalToken) {
    return { ok: false, error: serviceUnavailable("internal ingest token is unavailable") };
  }

  const presented = presentedBearerToken(request.headers.get("authorization"));
  if (!(await timingSafeEqualString(presented, internalToken))) {
    return { ok: false, error: emptyError("UNAUTHORIZED", "invalid internal ingest token") };
  }
  return { ok: true, value: true };
}

function presentedBearerToken(authorization: string | null): string {
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
}

export async function evaluationUsageScope(
  request: Request,
  env: Env,
): Promise<Outcome<EvaluationUsageScope>> {
  const credential = await credentialScope(request, env);
  if (!credential.ok) return credential;

  const organizationId = request.headers.get("x-splitch-organization-id");
  if (!organizationId) {
    return {
      ok: false,
      error: emptyError("UNAUTHORIZED", "missing internal Organization scope"),
    };
  }
  return { ok: true, value: { ...credential.value, organizationId } };
}
