import type { DelegatedIdentity } from "@splitch/worker-runtime";
import { entityStub } from "./entity-metric-privacy";
import {
  decodeEntityMetricPrivacyCursor,
  encodeEntityMetricPrivacyCursor,
} from "./entity-metric-privacy-cursor";
import type { Env } from "./types";

const ENTITY_PRIVACY_PAGE_MAX_LIMIT = 100;

export async function handleEntityMetricPrivacy(
  request: Request,
  env: Env,
  identity: DelegatedIdentity,
  operation: "export" | "suppress" | "delete",
): Promise<Response> {
  const appId = pathAppId(request);
  if (identity.appId !== appId) return new Response("forbidden", { status: 403 });
  const body = await privacyBody(request, operation);
  const response = await requestPrivacyStore(env, appId, body, operation);
  if (!response.ok) {
    return new Response("Entity Metric privacy store is unavailable", { status: 503 });
  }
  return privacyStoreResponse(appId, body, operation, await response.json());
}

async function requestPrivacyStore(
  env: Env,
  appId: string,
  body: PrivacyBody,
  operation: "export" | "suppress" | "delete",
): Promise<Response> {
  const stub = entityStub(env.ENTITY_METRIC_PRIVACY, {
    appId,
    idType: body.idType,
    entityFamilyHash: body.entityFamilyHash,
  });
  const exportCursor = operation === "export" ? exportAfter(body, appId) : null;
  const storeUrl = new URL(`https://entity-privacy.local/${operation}`);
  if (operation === "export") {
    storeUrl.searchParams.set("limit", String(body.limit));
    if (exportCursor !== null) storeUrl.searchParams.set("after", exportCursor);
  }
  return stub.fetch(storeUrl, {
    method: operation === "export" ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(operation === "export"
      ? {}
      : { body: JSON.stringify({ deleteBeforeTs: body.deleteBeforeTs }) }),
  });
}

function privacyStoreResponse(
  appId: string,
  body: PrivacyBody,
  operation: "export" | "suppress" | "delete",
  value: unknown,
): Response {
  const result = value as StoreResult;
  if (!Array.isArray(result.proofs) || result.proofs.some((proof) => typeof proof !== "string")) {
    return new Response("Entity Metric privacy store returned invalid proof", { status: 503 });
  }
  if (
    operation === "export" &&
    (!Array.isArray(result.records) ||
      (result.nextAfter !== null && typeof result.nextAfter !== "string"))
  ) {
    return new Response("Entity Metric privacy store returned invalid export", { status: 503 });
  }
  return Response.json({
    appId,
    idType: body.idType,
    targetingKeyHashes: body.targetingKeyHashes,
    entityFamilyHash: body.entityFamilyHash,
    ...(operation === "export"
      ? {
          records: result.records,
          nextCursor:
            typeof result.nextAfter === "string"
              ? encodeEntityMetricPrivacyCursor({
                  appId,
                  idType: body.idType,
                  entityFamilyHash: body.entityFamilyHash,
                  after: result.nextAfter,
                })
              : null,
        }
      : {}),
    proofs: result.proofs,
  });
}

interface PrivacyBody {
  idType: string;
  targetingKeyHashes: string[];
  entityFamilyHash: string;
  deleteBeforeTs?: string;
  limit?: number;
  cursor?: string | null;
}

interface StoreResult {
  records?: unknown;
  nextAfter?: unknown;
  proofs?: unknown;
}

export function requireEntityMetricPrivacyBinding(env: Env): void {
  if (
    !env.ENTITY_METRIC_PRIVACY &&
    env.SPLITCH_PLATFORM_TARGET !== "local" &&
    env.SPLITCH_PLATFORM_TARGET !== "pr-ci"
  ) {
    throw new Error("ENTITY_METRIC_PRIVACY binding is unavailable");
  }
}

function pathAppId(request: Request): string {
  const match = /^\/internal\/apps\/([^/]+)\/entity-events\/(?:export|suppress|delete)$/u.exec(
    new URL(request.url).pathname,
  );
  if (!match?.[1]) throw new Error("Entity Metric privacy path is invalid");
  return decodeURIComponent(match[1]);
}

async function privacyBody(
  request: Request,
  operation: "export" | "suppress" | "delete",
): Promise<PrivacyBody> {
  const body = (await request.json()) as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  const allowed =
    operation === "export"
      ? ["cursor", "entityFamilyHash", "idType", "limit", "targetingKeyHashes"]
      : ["deleteBeforeTs", "entityFamilyHash", "idType", "targetingKeyHashes"];
  if (keys.some((key) => !allowed.includes(key)))
    throw new Error("Entity Metric privacy body is ambiguous");
  if (
    typeof body.idType !== "string" ||
    typeof body.entityFamilyHash !== "string" ||
    !Array.isArray(body.targetingKeyHashes) ||
    body.targetingKeyHashes.length === 0 ||
    body.targetingKeyHashes.some((hash) => typeof hash !== "string") ||
    (body.deleteBeforeTs !== undefined && typeof body.deleteBeforeTs !== "string") ||
    (operation === "export" &&
      (!Number.isInteger(body.limit) ||
        Number(body.limit) < 1 ||
        Number(body.limit) > ENTITY_PRIVACY_PAGE_MAX_LIMIT ||
        (body.cursor !== null && typeof body.cursor !== "string")))
  ) {
    throw new Error("Entity Metric privacy body is invalid");
  }
  return {
    idType: body.idType,
    entityFamilyHash: body.entityFamilyHash,
    targetingKeyHashes: body.targetingKeyHashes as string[],
    ...(typeof body.deleteBeforeTs === "string" ? { deleteBeforeTs: body.deleteBeforeTs } : {}),
    ...(operation === "export"
      ? { limit: Number(body.limit), cursor: body.cursor as string | null }
      : {}),
  };
}

function exportAfter(
  body: { idType: string; entityFamilyHash: string; cursor?: string | null },
  appId: string,
): string | null {
  if (body.cursor === null) return null;
  if (typeof body.cursor !== "string" || body.cursor.length === 0) {
    throw new Error("Event Ingest Entity privacy cursor is invalid");
  }
  const cursor = decodeEntityMetricPrivacyCursor(body.cursor);
  if (
    cursor.appId !== appId ||
    cursor.idType !== body.idType ||
    cursor.entityFamilyHash !== body.entityFamilyHash
  ) {
    throw new Error("Event Ingest Entity privacy cursor has the wrong scope");
  }
  return cursor.after;
}
