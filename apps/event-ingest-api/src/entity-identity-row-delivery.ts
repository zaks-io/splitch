import {
  appIdentityPrivacyInventoryStub,
  atOrBefore,
  type EntityMetricPrivacyNamespace,
  rowIdentity,
} from "./entity-metric-privacy";
import { appendRawEvent, tinybirdDelivery } from "./tinybird";
import type { Env } from "./types";

interface SuppressionState {
  readonly deleteBeforeTs: string;
}

/**
 * A queue consumer combines many admitted rows into one Tinybird request
 * (ADR-0043), so it asks the authorities whether each row may be sent before
 * doing the batched append itself.
 */
export async function admitEntityIdentityRow(
  namespace: EntityMetricPrivacyNamespace | undefined,
  identityVersion: string,
  datasource: string,
  row: Record<string, unknown>,
  platformTarget: string | undefined,
): Promise<boolean> {
  return postEntityIdentityRow(
    "admit-entity-row",
    namespace,
    identityVersion,
    datasource,
    row,
    platformTarget,
  );
}

async function postEntityIdentityRow(
  route: string,
  namespace: EntityMetricPrivacyNamespace | undefined,
  identityVersion: string,
  datasource: string,
  row: Record<string, unknown>,
  platformTarget: string | undefined,
): Promise<boolean> {
  if (!namespace && (platformTarget === "local" || platformTarget === "pr-ci")) return false;
  const identity = rowIdentity(row);
  const response = await appIdentityPrivacyInventoryStub(namespace, identity.appId).fetch(
    `https://entity-privacy.local/${route}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...identity, identityVersion, datasource, row }),
    },
  );
  if (!response.ok) throw new Error(`Entity identity delivery returned HTTP ${response.status}`);
  const body = (await response.json()) as { suppressed?: unknown };
  if (typeof body.suppressed !== "boolean") {
    throw new Error("Entity identity delivery returned an invalid result");
  }
  return body.suppressed;
}

export async function deliverEntityRowAtAuthority(
  storage: DurableObjectStorage,
  env: Env,
  request: Request,
): Promise<Response> {
  const admitted = await admitEntityRowAtAuthority(storage, request);
  if (admitted.suppressed) return Response.json({ suppressed: true });
  const delivery = tinybirdDelivery(env, admitted.datasource);
  if (!delivery.ok) throw new Error(delivery.error.message);
  await appendRawEvent(admitted.row, delivery.value);
  return Response.json({ suppressed: false });
}

export async function admitEntityRowResponse(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  const admitted = await admitEntityRowAtAuthority(storage, request);
  return Response.json({ suppressed: admitted.suppressed });
}

type AdmittedRow =
  | { suppressed: true }
  | { suppressed: false; datasource: string; row: Record<string, unknown> };

async function admitEntityRowAtAuthority(
  storage: DurableObjectStorage,
  request: Request,
): Promise<AdmittedRow> {
  const body = (await request.json()) as Record<string, unknown>;
  if (!isRecord(body.row) || typeof body.datasource !== "string") {
    throw new Error("Entity delivery input is invalid");
  }
  const serverReceivedAt = body.row.server_received_at;
  if (typeof serverReceivedAt !== "string" || !Number.isFinite(Date.parse(serverReceivedAt))) {
    throw new Error("Entity delivery server_received_at is invalid");
  }
  const suppression = await storage.get<SuppressionState>("privacy:suppression");
  if (suppression && atOrBefore(serverReceivedAt, suppression.deleteBeforeTs)) {
    return { suppressed: true };
  }
  return { suppressed: false, datasource: body.datasource, row: body.row };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
