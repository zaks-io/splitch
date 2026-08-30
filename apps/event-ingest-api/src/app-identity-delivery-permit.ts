import { admitVersion } from "./app-identity-event-inventory";
import { entityStub, identityVersionForRow } from "./entity-metric-privacy";
import {
  completeDeliveryPermit,
  deliveryPermitId,
  recordDeliveryPermit,
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
  if (!(await admitVersion(storage, body.identityVersion))) {
    return Response.json({ suppressed: true });
  }
  await recordDeliveryPermit(storage, deliveryPermitId(body));
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
  const response = await entityStub(env.ENTITY_METRIC_PRIVACY, entityIdentity(body)).fetch(
    "https://entity-privacy.local/complete-row",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId }),
    },
  );
  if (!response.ok) throw new Error(`Entity identity completion returned ${response.status}`);
  return completeDeliveryPermit(storage, requestWithDeliveryId(deliveryId));
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
