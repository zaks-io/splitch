import { emptyError, renderError, serviceUnavailable } from "./errors";
import { loadRunScope } from "./kv-config";
import { readJsonObject, stringField } from "./payload";
import {
  appendRawEvent,
  evaluationUsageEvent,
  exposureEvent,
  tinybirdDelivery,
  toEvaluationUsageTinybirdRow,
  toTinybirdRow,
} from "./tinybird";
import type { CredentialScope, Env, EvaluationUsageScope, Outcome } from "./types";

/** The three body fields that identify the fire-time Run scope. */
function requiredIdentity(
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
  const credential = credentialScope(request, env);
  if (!credential.ok) return renderError(credential.error);

  const payload = await readJsonObject(request);
  if (!payload.ok) return renderError(payload.error);

  const fields = requiredIdentity(payload.value);
  if (!fields.ok) return renderError(fields.error);

  // The payload's runId is the SDK fire-time stamp — validated against its own
  // Run config, never replaced by the ingest-time live-run pointer.
  const runScope = await loadRunScope(
    env,
    credential.value,
    fields.value.experimentId,
    fields.value.idType,
    fields.value.runId,
  );
  if (!runScope.ok) return renderError(runScope.error);

  const event = await exposureEvent(payload.value, credential.value, runScope.value, env);
  if (!event.ok) return renderError(event.error);

  const delivery = tinybirdDelivery(env);
  if (!delivery.ok) return renderError(delivery.error);

  // The append is AWAITED before the ACK: the upstream Evaluation Worker treats
  // this response as the at-least-once delivery receipt (it 503s the evaluate
  // when the sink fails, so the SDK re-fires). ACKing 202 before Tinybird
  // durability would silently drop the row on an append failure.
  try {
    await appendRawEvent(toTinybirdRow(event.value, payload.value), delivery.value);
  } catch (error) {
    console.error("event-ingest-api Tinybird append failed", {
      appId: event.value.appId,
      environmentId: event.value.environmentId,
      experimentId: event.value.experimentId,
      runId: event.value.runId,
      eventId: event.value.eventId,
      type: event.value.type,
      errorMessage: error instanceof Error ? error.message : "non-error rejection",
    });
    return renderError(serviceUnavailable("raw event append failed"));
  }

  return Response.json(
    { ok: true, eventId: event.value.eventId, runId: event.value.runId },
    { status: 202 },
  );
}

export async function handleEvaluationIngest(request: Request, env: Env): Promise<Response> {
  const scope = evaluationUsageScope(request, env);
  if (!scope.ok) return renderError(scope.error);

  const payload = await readJsonObject(request);
  if (!payload.ok) return renderError(payload.error);

  const event = await evaluationUsageEvent(payload.value, scope.value);
  if (!event.ok) return renderError(event.error);

  const delivery = tinybirdDelivery(env, "raw_evaluations");
  if (!delivery.ok) return renderError(delivery.error);

  try {
    await appendRawEvent(toEvaluationUsageTinybirdRow(event.value), delivery.value);
  } catch (error) {
    console.error("event-ingest-api Tinybird Evaluation append failed", {
      organizationId: event.value.organizationId,
      appId: event.value.appId,
      environmentId: event.value.environmentId,
      errorMessage: error instanceof Error ? error.message : "non-error rejection",
    });
    return renderError(serviceUnavailable("Evaluation usage append failed"));
  }

  return Response.json({ ok: true, eventId: event.value.eventId }, { status: 202 });
}

function credentialScope(request: Request, env: Env): Outcome<CredentialScope> {
  const internalToken = env.SPLITCH_EVENT_INGEST_TOKEN;
  if (!internalToken) {
    return { ok: false, error: serviceUnavailable("internal ingest token is unavailable") };
  }
  if (request.headers.get("authorization") !== `Bearer ${internalToken}`) {
    return { ok: false, error: emptyError("UNAUTHORIZED", "invalid internal ingest token") };
  }

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

function evaluationUsageScope(request: Request, env: Env): Outcome<EvaluationUsageScope> {
  const credential = credentialScope(request, env);
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
