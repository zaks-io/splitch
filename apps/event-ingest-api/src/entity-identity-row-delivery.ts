import {
  appIdentityPrivacyInventoryStub,
  atOrBefore,
  rowIdentity,
  type EntityMetricPrivacyNamespace,
} from "./entity-metric-privacy";
import { appendRawEvent, tinybirdDelivery } from "./tinybird";
import type { Env } from "./types";

interface SuppressionState {
  readonly deleteBeforeTs: string;
}

/** App authority then Entity authority is the sole lock order for delivery and reset. */
export async function deliverEntityIdentityRow(
  namespace: EntityMetricPrivacyNamespace | undefined,
  identityVersion: string,
  datasource: string,
  row: Record<string, unknown>,
  platformTarget: string | undefined,
): Promise<boolean> {
  if (!namespace && (platformTarget === "local" || platformTarget === "pr-ci")) return false;
  const identity = rowIdentity(row);
  const response = await appIdentityPrivacyInventoryStub(namespace, identity.appId).fetch(
    "https://entity-privacy.local/deliver-entity-row",
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
    return Response.json({ suppressed: true });
  }
  const delivery = tinybirdDelivery(env, body.datasource);
  if (!delivery.ok) throw new Error(delivery.error.message);
  await appendRawEvent(body.row, delivery.value);
  return Response.json({ suppressed: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
