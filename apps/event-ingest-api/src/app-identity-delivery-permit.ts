import { admitVersion } from "./app-identity-event-inventory";
import { completeEntityDeliveryPermit } from "./entity-delivery-permit-client";
import { identityVersionForRow } from "./entity-metric-privacy";
import {
  completeDeliveryPermit,
  deliveryPermitId,
  recordDeliveryPermit,
  releaseDeliveryPermit,
} from "./raw-event-delivery-permit";
import type { Env } from "./types";

export async function admitAppIdentityRow(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  if (
    !isRecord(body.row) ||
    typeof body.appId !== "string" ||
    body.row.app_id !== body.appId ||
    typeof body.identityVersion !== "string" ||
    identityVersionForRow(body.row) !== body.identityVersion ||
    typeof body.datasource !== "string"
  ) {
    throw new Error("App identity admission input is invalid");
  }
  const deliveryId = deliveryPermitId(body);
  if (!(await admitVersion(storage, body.identityVersion))) {
    if (deliveryId !== undefined) await releaseDeliveryPermit(storage, deliveryId);
    return Response.json({ suppressed: true });
  }
  await recordDeliveryPermit(storage, deliveryId);
  return Response.json({ suppressed: false });
}

export async function completeAppIdentityRow(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  return completeDeliveryPermit(storage, request);
}

export async function completeEntityIdentityRow(
  storage: DurableObjectStorage,
  env: Env,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const deliveryId = deliveryPermitId(body);
  if (deliveryId === undefined) throw new Error("Raw event delivery permit id is unavailable");
  try {
    await completeEntityDeliveryPermit(env.ENTITY_METRIC_PRIVACY, entityIdentity(body), deliveryId);
  } finally {
    await completeDeliveryPermit(storage, requestWithDeliveryId(deliveryId));
  }
  return Response.json({ completed: true });
}

function entityIdentity(body: Record<string, unknown>) {
  if (
    typeof body.appId !== "string" ||
    typeof body.idType !== "string" ||
    typeof body.entityFamilyHash !== "string"
  ) {
    throw new Error("App Entity privacy inventory input is invalid");
  }
  return {
    appId: body.appId,
    idType: body.idType,
    entityFamilyHash: body.entityFamilyHash,
  };
}

function requestWithDeliveryId(deliveryId: string): Request {
  return new Request("https://entity-privacy.local/complete-entity-row", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deliveryId }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
