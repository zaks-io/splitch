import { timingSafeEqualString } from "@splitch/worker-runtime";
import { deliverEntityIdentityRow } from "./entity-identity-row-delivery";
import { deliverAppIdentityRow, identityVersionForRow } from "./entity-metric-privacy";
import { emptyError, renderError, serviceUnavailable } from "./errors";
import { evaluationUsageReplayWindow } from "./evaluation-usage-replay-window";
import { rejectIngestAdmission } from "./ingest-admission";
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
  const credential = await credentialScope(request, env);
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

  const row = toTinybirdRow(event.value, payload.value);
  const denied = await rejectIngestAdmission(
    env.INGEST_ADMISSION_GATE,
    {
      appId: credential.value.appId,
      environmentId: credential.value.environmentId,
      ingestStream: "raw_events",
    },
    [row],
    "Exposure ingest admission capacity exceeded",
  );
  if (denied) return denied;

  const failed = await deliverExposure(row, event.value, delivery.value, env);
  if (failed) return failed;

  return Response.json(
    { ok: true, eventId: event.value.eventId, runId: event.value.runId },
    { status: 202 },
  );
}

async function deliverExposure(
  row: Record<string, unknown>,
  event: {
    appId: string;
    environmentId: string;
    experimentId: string;
    runId: string;
    eventId: string;
    type: string;
  },
  delivery: { url: string; token: string },
  env: Env,
): Promise<Response | null> {
  // The append is AWAITED before the ACK: the upstream Evaluation Worker treats
  // this response as the at-least-once delivery receipt (it 503s the evaluate
  // when the sink fails, so the SDK re-fires). ACKing 202 before Tinybird
  // durability would silently drop the row on an append failure.
  try {
    if (env.SPLITCH_PLATFORM_TARGET === "local" || env.SPLITCH_PLATFORM_TARGET === "pr-ci") {
      await appendRawEvent(row, delivery);
    } else {
      await deliverEntityIdentityRow(
        env.ENTITY_METRIC_PRIVACY,
        identityVersionForRow(row),
        "raw_events",
        row,
        env.SPLITCH_PLATFORM_TARGET,
      );
    }
    return null;
  } catch (error) {
    console.error("event-ingest-api Tinybird append failed", {
      appId: event.appId,
      environmentId: event.environmentId,
      experimentId: event.experimentId,
      runId: event.runId,
      eventId: event.eventId,
      type: event.type,
      errorMessage: error instanceof Error ? error.message : "non-error rejection",
    });
    return renderError(serviceUnavailable("raw event append failed"));
  }
}

export async function handleEvaluationIngest(request: Request, env: Env): Promise<Response> {
  const scope = await evaluationUsageScope(request, env);
  if (!scope.ok) return renderError(scope.error);

  const payload = await readJsonObject(request);
  if (!payload.ok) return renderError(payload.error);

  const event = await evaluationUsageEvent(
    payload.value,
    scope.value,
    evaluationUsageReplayWindow(env.EVALUATION_USAGE_REPLAY_WINDOW),
  );
  if (!event.ok) return renderError(event.error);

  const row = toEvaluationUsageTinybirdRow(event.value);
  const denied = await rejectIngestAdmission(
    env.INGEST_ADMISSION_GATE,
    {
      appId: scope.value.appId,
      environmentId: scope.value.environmentId,
      ingestStream: "raw_evaluations",
    },
    [row],
    "Evaluation usage ingest admission capacity exceeded",
  );
  if (denied) return denied;

  try {
    const deliveryError = await deliverStandaloneEvaluationUsage(row, scope.value.appId, env);
    if (deliveryError) return deliveryError;
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

async function deliverStandaloneEvaluationUsage(
  row: Record<string, unknown>,
  appId: string,
  env: Env,
): Promise<Response | null> {
  if (env.SPLITCH_PLATFORM_TARGET === "local" || env.SPLITCH_PLATFORM_TARGET === "pr-ci") {
    const delivery = tinybirdDelivery(env, "raw_evaluations");
    if (!delivery.ok) return renderError(delivery.error);
    await appendRawEvent(row, delivery.value);
    return null;
  }
  await deliverAppIdentityRow(
    env.ENTITY_METRIC_PRIVACY,
    appId,
    identityVersionForRow(row),
    "raw_evaluations",
    row,
    env.SPLITCH_PLATFORM_TARGET,
  );
  return null;
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
