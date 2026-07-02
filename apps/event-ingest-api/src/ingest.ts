import { emptyError, renderError, serviceUnavailable } from "./errors.js";
import { loadLiveRun } from "./kv-config.js";
import { readJsonObject, stringField } from "./payload.js";
import { appendRawEvent, exposureEvent, tinybirdDelivery, toTinybirdRow } from "./tinybird.js";
import type { CredentialScope, Env, Outcome } from "./types.js";

export async function handleIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const credential = credentialScope(request, env);
  if (!credential.ok) return renderError(credential.error);

  const payload = await readJsonObject(request);
  if (!payload.ok) return renderError(payload.error);

  const experimentId = stringField(payload.value, "experimentId");
  const idType = stringField(payload.value, "idType");
  if (!experimentId.ok) return renderError(experimentId.error);
  if (!idType.ok) return renderError(idType.error);

  const liveRun = await loadLiveRun(env, credential.value, experimentId.value, idType.value);
  if (!liveRun.ok) return renderError(liveRun.error);

  const event = await exposureEvent(payload.value, credential.value, liveRun.value, env);
  if (!event.ok) return renderError(event.error);

  const delivery = tinybirdDelivery(env);
  if (!delivery.ok) return renderError(delivery.error);

  ctx.waitUntil(
    appendRawEvent(toTinybirdRow(event.value, payload.value), delivery.value).catch((error) => {
      console.error("event-ingest-api Tinybird append failed", {
        appId: event.value.appId,
        environmentId: event.value.environmentId,
        experimentId: event.value.experimentId,
        runId: event.value.runId,
        eventId: event.value.eventId,
        type: event.value.type,
        errorMessage: error instanceof Error ? error.message : "non-error rejection",
      });
      throw error;
    }),
  );

  return Response.json(
    { ok: true, eventId: event.value.eventId, runId: event.value.runId },
    { status: 202 },
  );
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
